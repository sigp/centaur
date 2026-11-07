//! Authenticate workflow-created Mattermost buttons without exposing the signing key to Python.
use std::env;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::Sha256;

use crate::{CreateWorkflowRunRequest, WorkflowRuntimeError};

const PREFIX: &str = "centaur.workflow.action:";
const INVALID: &str = "invalid or untrusted workflow button";
pub const MATTERMOST_WORKFLOW_ACTIONS_URL_ENV: &str = "MATTERMOST_WORKFLOW_ACTIONS_URL";

#[derive(Deserialize, Serialize)]
struct Target {
    workflow_name: String,
    input: Map<String, Value>,
}

#[derive(Deserialize, Serialize)]
struct Claims {
    platform: String,
    group_id: String,
    action: String,
    channel_id: String,
    #[serde(flatten)]
    target: Target,
}

#[derive(Deserialize)]
pub struct Invocation {
    pub button: String,
    pub click: Value,
    pub idempotency_key: String,
}

fn button_mac(secret: &[u8]) -> Hmac<Sha256> {
    let mut derive = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    derive.update(b"centaur:workflow-buttons:v1");
    Hmac::<Sha256>::new_from_slice(&derive.finalize().into_bytes())
        .expect("HMAC accepts a 32-byte key")
}

pub fn is_valid_channel_id(channel_id: &str) -> bool {
    channel_id.len() == 26
        && channel_id
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

/// Sign workflow actions in a Mattermost post's `props` tree.
///
/// Plain Mattermost posts are left unchanged and do not require the public
/// actions URL. A post containing a workflow action must have that URL set so
/// Mattermost can deliver the signed button click to the bot.
pub fn sign_message(message: &mut Value, secret: &[u8]) -> Result<(), WorkflowRuntimeError> {
    let actions_url = env::var(MATTERMOST_WORKFLOW_ACTIONS_URL_ENV)
        .ok()
        .filter(|url| !url.trim().is_empty());
    sign_message_with_actions_url(message, secret, actions_url.as_deref())
}

pub fn sign_message_with_actions_url(
    message: &mut Value,
    secret: &[u8],
    actions_url: Option<&str>,
) -> Result<(), WorkflowRuntimeError> {
    let channel_id = message
        .get("channel_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut found_action = false;

    fn visit(
        value: &mut Value,
        channel_id: &str,
        secret: &[u8],
        actions_url: Option<&str>,
        found_action: &mut bool,
    ) -> Result<(), WorkflowRuntimeError> {
        let Some(integration) = value.get_mut("integration").and_then(Value::as_object_mut) else {
            return match value {
                Value::Array(values) => {
                    for value in values {
                        visit(value, channel_id, secret, actions_url, found_action)?;
                    }
                    Ok(())
                }
                Value::Object(values) => {
                    for value in values.values_mut() {
                        visit(value, channel_id, secret, actions_url, found_action)?;
                    }
                    Ok(())
                }
                _ => Ok(()),
            };
        };

        let Some(context) = integration.get("context").and_then(Value::as_object) else {
            return Ok(());
        };
        let Some(action_id) = context
            .get("centaur_workflow_action")
            .and_then(Value::as_str)
            .and_then(|action_id| action_id.strip_prefix(PREFIX))
        else {
            return Ok(());
        };

        *found_action = true;
        let invalid = || WorkflowRuntimeError::BadRequest(INVALID.into());
        let (group, action) = action_id.split_once(':').ok_or_else(invalid)?;
        if uuid::Uuid::parse_str(group).is_err()
            || action.is_empty()
            || !is_valid_channel_id(channel_id)
            || secret.is_empty()
        {
            return Err(invalid());
        }
        let target: Target = serde_json::from_str(
            context
                .get("value")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        if target.workflow_name.trim().is_empty() {
            return Err(invalid());
        }
        let label = context.get("label").cloned().ok_or_else(invalid)?;
        let claims = Claims {
            platform: "mattermost".into(),
            group_id: group.into(),
            action: action.into(),
            channel_id: channel_id.into(),
            target,
        };
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
        let authenticated = format!("v1.{payload}");
        let mut mac = button_mac(secret);
        mac.update(authenticated.as_bytes());
        let token = format!(
            "{authenticated}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        );
        if token.len() > 2000 {
            return Err(WorkflowRuntimeError::BadRequest(
                "signed Mattermost button value exceeds 2000 bytes; reduce workflow input".into(),
            ));
        }
        let mut signed_context = Map::new();
        signed_context.insert(
            "centaur_workflow_action".into(),
            json!(format!("{PREFIX}{group}:{action}")),
        );
        signed_context.insert("label".into(), label);
        signed_context.insert("button".into(), json!(token));
        integration.insert("context".into(), Value::Object(signed_context));
        let actions_url = actions_url
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| {
                WorkflowRuntimeError::BadRequest(format!(
                    "{MATTERMOST_WORKFLOW_ACTIONS_URL_ENV} must be set for workflow buttons"
                ))
            })?;
        integration.insert("url".into(), json!(actions_url));
        Ok(())
    }

    if let Some(props) = message.get_mut("props") {
        visit(props, &channel_id, secret, actions_url, &mut found_action)?;
    }
    // Keep this assignment explicit so a future non-props Mattermost payload
    // cannot accidentally make a missing URL mandatory for ordinary posts.
    let _ = found_action;
    Ok(())
}

pub fn verify(
    invocation: Invocation,
    secret: &[u8],
) -> Result<CreateWorkflowRunRequest, &'static str> {
    if secret.is_empty() || invocation.button.len() > 2000 || !invocation.button.starts_with("v1.")
    {
        return Err(INVALID);
    }
    let (authenticated, signature) = invocation.button.rsplit_once('.').ok_or(INVALID)?;
    let signature = URL_SAFE_NO_PAD.decode(signature).map_err(|_| INVALID)?;
    let mut mac = button_mac(secret);
    mac.update(authenticated.as_bytes());
    mac.verify_slice(&signature).map_err(|_| INVALID)?;
    let payload = URL_SAFE_NO_PAD
        .decode(authenticated.strip_prefix("v1.").ok_or(INVALID)?)
        .map_err(|_| INVALID)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| INVALID)?;
    if claims.platform != "mattermost"
        || uuid::Uuid::parse_str(&claims.group_id).is_err()
        || claims.action.is_empty()
        || !is_valid_channel_id(&claims.channel_id)
        || claims.target.workflow_name.trim().is_empty()
        || invocation.click["id"] != claims.group_id
        || invocation.click["action"] != claims.action
        || invocation.click["channel_id"] != claims.channel_id
        || invocation.idempotency_key.is_empty()
    {
        return Err(INVALID);
    }
    let mut input = claims.target.input;
    input.insert("click".into(), invocation.click);
    input.insert("platform".into(), json!("mattermost"));
    Ok(CreateWorkflowRunRequest {
        workflow_name: claims.target.workflow_name,
        input: Value::Object(input),
        idempotency_key: Some(invocation.idempotency_key),
        harness_type: None,
        max_attempts: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUP: &str = "00000000-0000-0000-0000-000000000001";
    const CHANNEL: &str = "abcdefghijklmnopqrstuvwxyz";

    fn message() -> Value {
        json!({
            "channel_id": CHANNEL,
            "message": "Approve release?",
            "props": {"attachments": [{"text": "", "actions": [{
                "id": "a0",
                "name": "Approve",
                "type": "button",
                "style": "primary",
                "integration": {"context": {
                    "centaur_workflow_action": format!("{PREFIX}{GROUP}:approve"),
                    "label": "Approve",
                    "value": json!({"workflow_name": "review", "input": {"release_id": "r1"}}).to_string(),
                }}
            }]}]}
        })
    }

    fn invocation(button: String) -> Invocation {
        Invocation {
            button,
            idempotency_key: "delivery-1".into(),
            click: json!({
                "id": GROUP,
                "action": "approve",
                "channel_id": CHANNEL,
                "post_id": "post-1",
                "team_id": "team-1",
                "user_id": "user-1",
                "user_name": "Alex",
                "trigger_id": "trigger-1"
            }),
        }
    }

    #[test]
    fn signatures_round_trip_and_bind_mattermost_claims() {
        let mut posted = message();
        sign_message_with_actions_url(&mut posted, b"test-secret", Some("https://mm/actions"))
            .unwrap();
        let context = &posted["props"]["attachments"][0]["actions"][0]["integration"]["context"];
        assert!(context.get("value").is_none());
        assert_eq!(
            posted["props"]["attachments"][0]["actions"][0]["integration"]["url"],
            "https://mm/actions"
        );
        let token = context["button"].as_str().unwrap().to_owned();
        let run = verify(invocation(token.clone()), b"test-secret").unwrap();
        assert_eq!(run.workflow_name, "review");
        assert_eq!(run.input["release_id"], "r1");
        assert_eq!(run.input["platform"], "mattermost");
        assert_eq!(run.input["click"]["user_id"], "user-1");
        assert!(verify(invocation(token), b"other-secret").is_err());
    }

    #[test]
    fn rejects_invalid_channel_and_missing_actions_url() {
        let mut posted = message();
        posted["channel_id"] = json!("general");
        assert!(
            sign_message_with_actions_url(&mut posted, b"secret", Some("https://mm/actions"))
                .is_err()
        );
        let mut posted = message();
        assert!(sign_message_with_actions_url(&mut posted, b"secret", None).is_err());
        let mut plain = json!({"channel_id": "general", "message": "hello"});
        sign_message_with_actions_url(&mut plain, b"", None).unwrap();
    }

    #[test]
    fn rejects_click_mismatches() {
        let mut posted = message();
        sign_message_with_actions_url(&mut posted, b"test-secret", Some("https://mm/actions"))
            .unwrap();
        let token =
            posted["props"]["attachments"][0]["actions"][0]["integration"]["context"]["button"]
                .as_str()
                .unwrap()
                .to_owned();
        for field in ["id", "action", "channel_id"] {
            let mut forged = invocation(token.clone());
            forged.click[field] = json!("other");
            assert!(verify(forged, b"test-secret").is_err(), "{field}");
        }
    }

    #[test]
    fn slack_verification_rejects_a_mattermost_button() {
        let mut posted = message();
        sign_message_with_actions_url(&mut posted, b"test-secret", Some("https://mm/actions"))
            .unwrap();
        let token =
            posted["props"]["attachments"][0]["actions"][0]["integration"]["context"]["button"]
                .as_str()
                .unwrap()
                .to_owned();
        // The click matches the claims, so only the platform binding refuses it.
        let slack = crate::slack_buttons::Invocation {
            button: token,
            click: json!({"id": GROUP, "action": "approve", "channel_id": CHANNEL}),
            idempotency_key: "delivery-1".into(),
            message: None,
        };
        assert!(crate::slack_buttons::verify(slack, b"test-secret").is_err());
    }
}
