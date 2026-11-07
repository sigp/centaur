// Bun imports TOML files natively (used for harness/codex/config.toml).
declare module "*.toml" {
  const value: Record<string, unknown>;
  export default value;
}
