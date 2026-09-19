#!/bin/sh
set -eu

usage() {
  printf '%s\n' \
    'usage: subscription-policy.sh route --role default|implementation --claude-status STATUS [--fallback-authorization owner|accepted-plan] [--codex-auth chatgpt|api-key|unavailable]' >&2
}

deny() {
  printf 'SUBSCRIPTION_ROUTE_DENIED reason=%s\n' "$1" >&2
  exit 78
}

if [ "${1-}" != "route" ]; then
  usage
  exit 64
fi
shift

role=
claude_status=
fallback_authorization=none
codex_auth=unavailable

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role) role=${2-}; shift 2 ;;
    --claude-status) claude_status=${2-}; shift 2 ;;
    --fallback-authorization) fallback_authorization=${2-}; shift 2 ;;
    --codex-auth) codex_auth=${2-}; shift 2 ;;
    *) usage; exit 64 ;;
  esac
done

case "$role" in
  default)
    claude_model=sonnet
    codex_model=gpt-5.6-sol
    ;;
  implementation)
    claude_model=opus
    codex_model=gpt-6-astra
    ;;
  *)
    usage
    exit 64
    ;;
esac

if [ "$claude_status" = "available" ]; then
  printf 'provider=claude model=%s role=%s fallback=false reason=preferred\n' \
    "$claude_model" "$role"
  exit 0
fi

case "$claude_status" in
  authentication_failure|capacity_unavailable|monthly_spend_limit|subscription_unavailable) ;;
  *) deny "claude_status_not_eligible" ;;
esac

case "$fallback_authorization" in
  owner|accepted-plan) ;;
  *) deny "fallback_not_authorized" ;;
esac

case "$codex_auth" in
  chatgpt) ;;
  api-key) deny "api_key_fallback_forbidden" ;;
  unavailable) deny "no_subscription_worker_available" ;;
  *) deny "codex_auth_not_supported" ;;
esac

printf 'provider=codex model=%s role=%s fallback=true reason=%s authorization=%s\n' \
  "$codex_model" "$role" "$claude_status" "$fallback_authorization"
