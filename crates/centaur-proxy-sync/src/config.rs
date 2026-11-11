use std::collections::BTreeSet;

use centaur_console_db::{SecretValues, Subject, models::Config, oid};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    ApiError,
    models::{AppState, ProxyRecord},
    tokens::{append_api_jwt, append_sandbox_jwt},
};

pub(crate) async fn build_config(
    state: &AppState,
    proxy: &ProxyRecord,
    principal_id: i64,
    now: i64,
) -> Result<Config, ApiError> {
    let subject = Subject {
        principal_id,
        principal: proxy.principal.as_ref(),
        console_user_id: proxy.console_user_id,
        console_user_email: proxy.console_user_email.as_deref(),
        slack_history_channel_ids: &proxy.slack_history_channel_ids,
        proxy_labels: &proxy.labels,
    };
    let mut config = centaur_console_db::build_config(
        &state.pool,
        SecretValues::Live(&state.encryption),
        &subject,
        proxy.requester_principal_id,
    )
    .await?;
    append_api_jwt(state, proxy, &mut config, now).await?;
    append_sandbox_jwt(state, proxy, &mut config, now)?;
    Ok(config)
}

/// Prepend the default-deny allowlist to an offline proxy's config. Applied to
/// every offline proxy, including unassigned ones, so none can forward anywhere
/// but the configured hosts.
pub(crate) fn apply_offline_allowlist(
    config: &mut Config,
    proxy: &ProxyRecord,
    offline_hosts: &[String],
    api_hosts: &[String],
    console_host: Option<&str>,
) {
    if proxy.labels.get("network_profile").and_then(Value::as_str) != Some("offline") {
        return;
    }
    let hosts = offline_allowlist_hosts(offline_hosts, api_hosts, console_host);
    config
        .transforms
        .insert(0, offline_allowlist_transform(&hosts));
}

fn offline_allowlist_hosts(
    offline_hosts: &[String],
    api_hosts: &[String],
    console_host: Option<&str>,
) -> Vec<String> {
    offline_hosts
        .iter()
        .chain(api_hosts)
        .map(String::as_str)
        .chain(console_host)
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn offline_allowlist_transform(hosts: &[String]) -> Value {
    json!({
        "name": "allowlist",
        "config": { "domains": hosts },
    })
}

pub(crate) fn config_hash(proxy: &ProxyRecord, config: &Value) -> Result<String, ApiError> {
    let mut payload = config
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::internal("config was not an object"))?;
    payload.insert(
        "principal".to_owned(),
        proxy
            .principal_id
            .map(|id| Value::String(oid("prn", id)))
            .unwrap_or(Value::Null),
    );
    payload.insert(
        "principal_assigned_at".to_owned(),
        timestamp(proxy.principal_assigned_at),
    );
    payload.insert("proxy_labels".to_owned(), proxy.labels.clone());
    if proxy.requester_principal_id.is_some() {
        payload.insert(
            "requester_principal".to_owned(),
            proxy
                .requester_principal_id
                .map(|id| Value::String(oid("prn", id)))
                .unwrap_or(Value::Null),
        );
        payload.insert(
            "requester_principal_assigned_at".to_owned(),
            timestamp(proxy.requester_principal_assigned_at),
        );
    }
    let canonical = serde_json::to_vec(&Value::Object(payload))
        .map_err(|_| ApiError::internal("config serialization failed"))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(canonical))))
}

fn timestamp(value: Option<DateTime<Utc>>) -> Value {
    value
        .map(|value| Value::String(value.format("%Y-%m-%dT%H:%M:%SZ").to_string()))
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use centaur_console_db::models::Config;
    use serde_json::json;

    use crate::models::ProxyRecord;

    use super::{apply_offline_allowlist, offline_allowlist_hosts, offline_allowlist_transform};

    #[test]
    fn offline_allowlist_includes_centaur_hosts_and_deduplicates() {
        let hosts = offline_allowlist_hosts(
            &[
                "slipway.slipway.svc.cluster.local".to_owned(),
                "api.internal".to_owned(),
            ],
            &["api.internal".to_owned(), "api-rs".to_owned()],
            Some("console.internal"),
        );
        assert_eq!(
            hosts,
            vec![
                "api-rs",
                "api.internal",
                "console.internal",
                "slipway.slipway.svc.cluster.local",
            ]
        );
        assert_eq!(
            offline_allowlist_transform(&hosts),
            serde_json::json!({
                "name": "allowlist",
                "config": { "domains": hosts }
            })
        );
    }

    #[test]
    fn offline_proxy_without_principal_gets_default_deny_allowlist() {
        let mut config = Config::default();
        let proxy = ProxyRecord {
            id: 1,
            name: "offline-unassigned".to_owned(),
            labels: json!({ "network_profile": "offline" }),
            principal_id: None,
            requester_principal_id: None,
            principal_assigned_at: None,
            requester_principal_assigned_at: None,
            principal_cache_version: None,
            principal: None,
            console_user_email: None,
            console_user_id: None,
            slack_history_channel_ids: json!([]),
        };

        assert!(proxy.principal_id.is_none());

        apply_offline_allowlist(
            &mut config,
            &proxy,
            &["slipway.slipway.svc.cluster.local".to_owned()],
            &["api.internal".to_owned()],
            Some("console.internal"),
        );

        assert_eq!(
            config.transforms.first(),
            Some(&json!({
                "name": "allowlist",
                "config": {
                    "domains": [
                        "api.internal",
                        "console.internal",
                        "slipway.slipway.svc.cluster.local"
                    ]
                }
            }))
        );
    }
}
