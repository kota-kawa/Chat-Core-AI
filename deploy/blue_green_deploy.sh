#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.bluegreen.yml}"
LEGACY_COMPOSE_FILE="${LEGACY_COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env}"
STATE_FILE="${DEPLOY_STATE_FILE:-.deploy-active-color}"
NGINX_UPSTREAM_DIR="${NGINX_UPSTREAM_DIR:-/etc/nginx/chatcore-ai/upstreams}"
NGINX_SITE_PATH="${NGINX_SITE_PATH:-}"
NGINX_TEST_CMD="${NGINX_TEST_CMD:-}"
NGINX_RELOAD_CMD="${NGINX_RELOAD_CMD:-}"
DEPLOY_TARGET_COLOR="${DEPLOY_TARGET_COLOR:-}"

is_empty_or_unresolved() {
  local value="${1:-}"
  [ -z "${value}" ] || [[ "${value}" =~ ^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$ ]]
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

compose() {
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" "$@"
}

legacy_compose() {
  docker compose --env-file "${ENV_FILE}" -f "${LEGACY_COMPOSE_FILE}" "$@"
}

require_env_file() {
  if [ ! -f "${ENV_FILE}" ]; then
    echo "Required env file not found: ${ENV_FILE}" >&2
    exit 1
  fi
}

load_env_file() {
  set +u
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
  set -u
}

apply_legacy_env_fallback() {
  local target_var="$1"
  local legacy_var="$2"
  local current_value="${!target_var:-}"
  local legacy_value="${!legacy_var:-}"

  if is_empty_or_unresolved "${current_value}" && ! is_empty_or_unresolved "${legacy_value}"; then
    export "${target_var}=${legacy_value}"
    echo "Using legacy environment variable ${legacy_var} for ${target_var}." >&2
  fi
}

apply_legacy_env_fallbacks() {
  apply_legacy_env_fallback POSTGRES_USER MYSQL_USER
  apply_legacy_env_fallback POSTGRES_PASSWORD MYSQL_PASSWORD
  apply_legacy_env_fallback POSTGRES_DB MYSQL_DATABASE
  apply_legacy_env_fallback FASTAPI_SECRET_KEY FLASK_SECRET_KEY
  apply_legacy_env_fallback FASTAPI_ENV FLASK_ENV
}

preflight_compose_config() {
  compose config >/dev/null
}

validate_required_env() {
  local required_vars=(
    POSTGRES_DB
    POSTGRES_USER
    POSTGRES_PASSWORD
    FASTAPI_SECRET_KEY
  )
  local var_name value missing=0

  for var_name in "${required_vars[@]}"; do
    value="${!var_name:-}"
    if is_empty_or_unresolved "${value}"; then
      echo "Required environment variable is empty or unresolved: ${var_name}" >&2
      missing=1
    fi
  done

  if [ "${missing}" -ne 0 ]; then
    exit 1
  fi
}

require_cmd docker
require_env_file
load_env_file
apply_legacy_env_fallbacks
preflight_compose_config
validate_required_env

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_root_shell() {
  local command_string="$1"
  if [ "$(id -u)" -eq 0 ]; then
    bash -lc "${command_string}"
  else
    sudo bash -lc "${command_string}"
  fi
}

nginx_test() {
  if [ -n "${NGINX_TEST_CMD}" ]; then
    run_root_shell "${NGINX_TEST_CMD}"
    return
  fi

  if command -v nginx >/dev/null 2>&1; then
    run_root nginx -t
    return
  fi

  run_root /usr/sbin/nginx -t
}

nginx_reload() {
  if [ -n "${NGINX_RELOAD_CMD}" ]; then
    run_root_shell "${NGINX_RELOAD_CMD}"
    return
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl reload nginx
    return
  fi

  if command -v nginx >/dev/null 2>&1; then
    run_root nginx -s reload
    return
  fi

  run_root /usr/sbin/nginx -s reload
}

wait_for_service_healthy() {
  local service="$1"
  local retries="${2:-90}"
  local cid status

  while [ "${retries}" -gt 0 ]; do
    cid="$(compose ps -q "${service}" || true)"
    if [ -z "${cid}" ]; then
      echo "Service ${service} container is missing." >&2
      return 1
    fi

    status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${cid}")"
    if [ "${status}" = "healthy" ]; then
      echo "Service ${service} is healthy."
      return 0
    fi

    if [ "${status}" = "unhealthy" ] || [ "${status}" = "exited" ] || [ "${status}" = "dead" ]; then
      echo "Service ${service} is ${status}." >&2
      return 1
    fi

    sleep 2
    retries=$((retries - 1))
  done

  echo "Timed out waiting for ${service} to become healthy." >&2
  return 1
}

write_text_as_root() {
  local target_file="$1"
  local content="$2"

  if [ "$(id -u)" -eq 0 ]; then
    printf "%s" "${content}" > "${target_file}"
  else
    printf "%s" "${content}" | sudo tee "${target_file}" >/dev/null
  fi
}

write_active_upstreams() {
  local color="$1"
  local backend_port frontend_port

  case "${color}" in
    blue)
      backend_port="5004"
      frontend_port="3000"
      ;;
    green)
      backend_port="5005"
      frontend_port="3001"
      ;;
    *)
      echo "Unsupported color: ${color}" >&2
      return 1
      ;;
  esac

  run_root install -d -m 755 "${NGINX_UPSTREAM_DIR}"

  write_text_as_root "${NGINX_UPSTREAM_DIR}/backend_active.conf" "server 127.0.0.1:${backend_port};"$'\n'
  write_text_as_root "${NGINX_UPSTREAM_DIR}/frontend_active.conf" "server 127.0.0.1:${frontend_port};"$'\n'

  if [ -n "${NGINX_SITE_PATH}" ]; then
    run_root install -m 644 chatcore-ai.conf "${NGINX_SITE_PATH}"
  fi

  nginx_test
  nginx_reload
}

detect_active_color() {
  local color

  if [ -f "${STATE_FILE}" ]; then
    read -r color < "${STATE_FILE}" || true
    case "${color}" in
      blue|green)
        echo "${color}"
        return
        ;;
    esac
  fi

  if [ -f "${NGINX_UPSTREAM_DIR}/backend_active.conf" ]; then
    if grep -q "127.0.0.1:5005" "${NGINX_UPSTREAM_DIR}/backend_active.conf"; then
      echo "green"
      return
    fi
    if grep -q "127.0.0.1:5004" "${NGINX_UPSTREAM_DIR}/backend_active.conf"; then
      echo "blue"
      return
    fi
  fi

  if [ -n "$(compose ps -q app_green || true)" ]; then
    echo "green"
    return
  fi

  if [ -n "$(compose ps -q app_blue || true)" ]; then
    echo "blue"
    return
  fi

  if [ -f "${LEGACY_COMPOSE_FILE}" ] && [ -n "$(legacy_compose ps -q app || true)" ]; then
    echo "blue"
    return
  fi

  echo "none"
}

next_color() {
  case "$1" in
    blue)
      echo "green"
      ;;
    green)
      echo "blue"
      ;;
    *)
      echo "blue"
      ;;
  esac
}

start_core_services() {
  compose up -d db redis
  wait_for_service_healthy db 90
  wait_for_service_healthy redis 90
}

build_runtime_images() {
  local color="$1"
  compose build "app_${color}" "frontend_${color}"
}

run_migrations() {
  local color="$1"
  compose run --rm "app_${color}" alembic upgrade head
}

deploy_color() {
  local color="$1"
  compose up -d --no-deps "app_${color}" "frontend_${color}"
  wait_for_service_healthy "app_${color}" 90
  wait_for_service_healthy "frontend_${color}" 90
}

stop_color() {
  local color="$1"

  if [ "${color}" = "none" ]; then
    return 0
  fi

  compose stop "app_${color}" "frontend_${color}" >/dev/null 2>&1 || true
  compose rm -f "app_${color}" "frontend_${color}" >/dev/null 2>&1 || true
}

stop_legacy_services() {
  if [ ! -f "${LEGACY_COMPOSE_FILE}" ]; then
    return 0
  fi

  legacy_compose stop app frontend >/dev/null 2>&1 || true
  legacy_compose rm -f app frontend >/dev/null 2>&1 || true
}

CURRENT_COLOR="$(detect_active_color)"
TARGET_COLOR="${DEPLOY_TARGET_COLOR}"

if [ -z "${TARGET_COLOR}" ]; then
  TARGET_COLOR="$(next_color "${CURRENT_COLOR}")"
  if [ "${CURRENT_COLOR}" = "none" ]; then
    TARGET_COLOR="blue"
  fi
fi

if [ "${TARGET_COLOR}" = "${CURRENT_COLOR}" ] && [ "${CURRENT_COLOR}" != "none" ]; then
  echo "Target color matches the active color (${CURRENT_COLOR}). Choose the inactive color instead." >&2
  exit 1
fi

SWITCHED=0

rollback() {
  local exit_code="$?"

  if [ "${SWITCHED}" -eq 1 ] && [ "${CURRENT_COLOR}" != "none" ]; then
    echo "Reverting traffic to ${CURRENT_COLOR}." >&2
    write_active_upstreams "${CURRENT_COLOR}" || true
    printf "%s\n" "${CURRENT_COLOR}" > "${STATE_FILE}" || true
  fi

  stop_color "${TARGET_COLOR}" || true
  exit "${exit_code}"
}

trap rollback ERR

echo "Current color: ${CURRENT_COLOR}"
echo "Deploying inactive color: ${TARGET_COLOR}"

start_core_services
build_runtime_images "${TARGET_COLOR}"
run_migrations "${TARGET_COLOR}"
deploy_color "${TARGET_COLOR}"
write_active_upstreams "${TARGET_COLOR}"
printf "%s\n" "${TARGET_COLOR}" > "${STATE_FILE}"
SWITCHED=1

if [ "${CURRENT_COLOR}" != "none" ]; then
  stop_color "${CURRENT_COLOR}"
fi

stop_legacy_services

trap - ERR

docker image prune -f >/dev/null 2>&1 || true
compose ps
echo "Active deployment color: ${TARGET_COLOR}"
