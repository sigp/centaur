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
    if proxy
        .labels
        .get("network_profile")
        .and_then(Value::as_str)
        == Some("offline")
    {
        let hosts = offline_allowlist_hosts(
            &state.offline_allowed_hosts,
            &state.api_hosts,
            state.console_host.as_deref(),
        );
        config
            .transforms
            .insert(0, offline_allowlist_transform(&hosts));
    }
    append_api_jwt(state, proxy, &mut config, now).await?;
    append_sandbox_jwt(state, proxy, &mut config, now)?;
    Ok(config)
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

#[cfg(test)]
mod tests {
    use super::{offline_allowlist_hosts, offline_allowlist_transform};

    #[test]
    fn offline_allowlist_includes_centaur_hosts_and_deduplicates() {
        let hosts = offline_allowlist_hosts(
            &["slipway.slipway.svc.cluster.local".to_owned(), "api.internal".to_owned()],
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
