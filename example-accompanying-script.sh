#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

INTEGRATION_DIR="$REPO_DIR/integration"
DEV_DIR="$REPO_DIR/minecraft-dev"

CONTROL_HOST="127.0.0.1"
CONTROL_PORT="${TEST_CONTROL_PORT:-25575}"
MINECRAFT_PORT="${TEST_SERVER_PORT:-25565}"

CONTROL_PID=""
TEST_PID=""
EXIT_CODE=0
CLEANING_UP=false

log_section() {
    echo
    echo "============================================================"
    echo "$1"
    echo "============================================================"
}

die() {
    echo
    echo "ERROR: $*" >&2
    exit 1
}

require_command() {
    local command="$1"
    local description="$2"

    if ! command -v "$command" >/dev/null 2>&1; then
        die "$description ('$command') was not found in PATH."
    fi
}

source "$SCRIPT_DIR/test-server-process.sh"

control_port_is_open() {
    (echo >"/dev/tcp/$CONTROL_HOST/$CONTROL_PORT") >/dev/null 2>&1
}

control_server_is_ready() {
    local response=""

    if ! exec 3<>"/dev/tcp/$CONTROL_HOST/$CONTROL_PORT" 2>/dev/null; then
        return 1
    fi

    # The harness protocol uses one JSON response per line. The old runner
    # expected the legacy plain-text response "pong", which meant it could
    # wait forever even after the controller and Paper were fully ready.
    if ! printf '{"version":1,"command":"ping","args":[]}\n' >&3; then
        exec 3>&- || true
        exec 3<&- || true
        return 1
    fi

    IFS= read -r -t 2 response <&3 || true

    exec 3>&- || true
    exec 3<&- || true

    [[ "$response" == *'"version":1'* ]] &&
        [[ "$response" == *'"ok":true'* ]] &&
        [[ "$response" == *'"message":"pong"'* ]]
}

wait_for_control_server() {
    local timeout_seconds="$1"
    local elapsed=0

    while (( elapsed < timeout_seconds )); do
        if control_server_is_ready; then
            return 0
        fi

        if [[ -n "$CONTROL_PID" ]] && ! pid_is_alive "$CONTROL_PID"; then
            return 1
        fi

        sleep 1
        ((elapsed += 1))
    done

    return 1
}

cleanup_controller() {
    local pid="$CONTROL_PID"

    [[ -n "$pid" ]] || return 0

    if pid_is_alive "$pid"; then
        echo "Stopping Minecraft test controller PID $pid..."
        kill -TERM "$pid" 2>/dev/null || true

        if ! wait_for_pid_exit "$pid" 20; then
            echo "Controller PID $pid did not exit; sending SIGKILL..."
            kill -KILL "$pid" 2>/dev/null || true
            wait_for_pid_exit "$pid" 5 || true
        fi
    fi

    wait "$pid" 2>/dev/null || true
    CONTROL_PID=""
}

cleanup_tests() {
    if [[ -z "$TEST_PID" ]] || ! pid_is_alive "$TEST_PID"; then
        TEST_PID=""
        return 0
    fi

    echo "Stopping integration test process PID $TEST_PID..."
    kill -TERM "$TEST_PID" 2>/dev/null || true

    if ! wait_for_pid_exit "$TEST_PID" 10; then
        echo "Integration test process did not exit; sending SIGKILL..."
        kill -KILL "$TEST_PID" 2>/dev/null || true
        wait_for_pid_exit "$TEST_PID" 5 || true
    fi

    wait "$TEST_PID" 2>/dev/null || true
    TEST_PID=""
}

verify_no_owned_paper() {
    local pids
    pids="$(find_test_paper_pids || true)"

    if [[ -n "$pids" ]]; then
        echo >&2
        echo "ERROR: Test cleanup found Paper processes that are still running:" >&2
        while read -r pid; do
            [[ -n "$pid" ]] || continue
            echo "  PID $pid: $(process_command "$pid")" >&2
        done <<<"$pids"
        return 1
    fi

    return 0
}

cleanup() {
    if [[ "$CLEANING_UP" == true ]]; then
        return
    fi

    CLEANING_UP=true

    echo
    echo "Cleaning up integration test environment..."

    cleanup_tests
    cleanup_controller

    # The controller owns its Paper child and normally shuts it down itself.
    # Scan once more for orphaned Paper JVMs so even a killed controller cannot
    # leave the next run with two Paper processes.
    stop_test_paper_processes

    if ! verify_no_owned_paper; then
        echo "WARNING: Paper cleanup was not fully successful." >&2
        [[ "$EXIT_CODE" -eq 0 ]] && EXIT_CODE=1
    fi
}

handle_interrupt() {
    local signal="$1"

    echo
    echo "Interrupted by $signal. Stopping integration tests..."

    case "$signal" in
        INT) EXIT_CODE=130 ;;
        TERM) EXIT_CODE=143 ;;
        *) EXIT_CODE=1 ;;
    esac

    cleanup
    trap - EXIT INT TERM
    exit "$EXIT_CODE"
}

trap cleanup EXIT
trap 'handle_interrupt INT' INT
trap 'handle_interrupt TERM' TERM

cd "$REPO_DIR"

log_section "Checking prerequisites"

require_command "java" "Java is required"
require_command "mvn" "Maven is required"
require_command "node" "Node.js is required"
require_command "npm" "npm is required"
require_command "wget" "wget is required"

if ! [[ "$CONTROL_PORT" =~ ^[0-9]+$ ]] || (( CONTROL_PORT < 1 || CONTROL_PORT > 65535 )); then
    die "Invalid TEST_CONTROL_PORT: $CONTROL_PORT"
fi

if ! [[ "$MINECRAFT_PORT" =~ ^[0-9]+$ ]] || (( MINECRAFT_PORT < 1 || MINECRAFT_PORT > 65535 )); then
    die "Invalid TEST_SERVER_PORT: $MINECRAFT_PORT"
fi

echo "Java:  $(java -version 2>&1 | head -n 1)"
echo "Node:  $(node --version)"
echo "npm:   $(npm --version)"
echo "Maven: $(mvn --version | head -n 1)"
echo "Control port:    $CONTROL_PORT"
echo "Minecraft port:  $MINECRAFT_PORT"

if [[ ! -f "$INTEGRATION_DIR/package.json" ]]; then
    die "Integration package.json was not found."
fi

if [[ ! -f "$INTEGRATION_DIR/package-lock.json" ]]; then
    die "integration/package-lock.json is missing."
fi

log_section "Preparing integration dependencies"

cd "$INTEGRATION_DIR"

if [[ ! -x "$INTEGRATION_DIR/node_modules/.bin/vitest" ||
      ! -x "$INTEGRATION_DIR/node_modules/.bin/minecraft-test-controller" ||
      ! -d "$INTEGRATION_DIR/node_modules/@byteafterlife/minecraft-integration-harness" ]]; then
    echo "Integration dependencies are missing or incomplete."
    echo "Running npm ci..."
    npm ci --include=dev
else
    echo "Integration dependencies already installed."
fi

cd "$REPO_DIR"

log_section "Building plugin"

mvn clean package

PLUGIN="$REPO_DIR/target/compiled-1.0.jar"

if [[ ! -f "$PLUGIN" ]]; then
    die "Maven completed but $PLUGIN was not produced."
fi

log_section "Preparing Minecraft test server"

# The controller owns this TCP port for the entire lifecycle. If it is
# already open, another integration run owns the test environment; do not
# reset its server directory underneath it.
if control_port_is_open; then
    die "Another integration test controller is already using $CONTROL_HOST:$CONTROL_PORT. Refusing to reset the test server while it is running."
fi

# Never reset a live server. Remove any stale Paper JVMs from the dedicated
# test-server directory first, including orphaned JVMs whose cwd is deleted.
stop_test_paper_processes

if [[ -n "$(find_test_paper_pids || true)" ]]; then
    die "A Paper process is still running for '$DEV_DIR'. Refusing to reset it."
fi

"$SCRIPT_DIR/create-test-server.sh" \
    --test \
    --reset \
    --setup-only

log_section "Starting Minecraft test controller"

cd "$INTEGRATION_DIR"

# Controller output intentionally stays on stdout/stderr. The harness keeps
# runtime state in memory and does not create log, lock, or PID files.
TEST_CONTROL_PORT="$CONTROL_PORT" \
TEST_SERVER_PORT="$MINECRAFT_PORT" \
    "$INTEGRATION_DIR/node_modules/.bin/minecraft-test-controller" \
        --server-dir "$DEV_DIR" \
        --server-host "$CONTROL_HOST" \
        --server-port "$MINECRAFT_PORT" \
        --control-host "$CONTROL_HOST" \
        --control-port "$CONTROL_PORT" &

CONTROL_PID=$!

echo "Controller PID: $CONTROL_PID"
echo "Controller output: stdout/stderr"
echo "If you see some connection refused errors below, those are expected."
echo
echo "Waiting for Minecraft controller and Paper to become ready..."

if ! wait_for_control_server 120; then
    echo >&2
    echo "Minecraft test controller did not become ready." >&2
    if [[ -n "$CONTROL_PID" ]] && ! pid_is_alive "$CONTROL_PID"; then
        wait "$CONTROL_PID" 2>/dev/null || true
    fi
    exit 1
fi

echo "Minecraft controller health check passed."
echo "Minecraft server is ready."

log_section "Running integration tests"

cd "$INTEGRATION_DIR"

TEST_CONTROL_PORT="$CONTROL_PORT" \
TEST_SERVER_PORT="$MINECRAFT_PORT" \
    npm test &

TEST_PID=$!

if wait "$TEST_PID"; then
    EXIT_CODE=0
else
    EXIT_CODE=$?
fi

TEST_PID=""

if [[ "$EXIT_CODE" -ne 0 ]]; then
    echo
    echo "============================================================"
    echo "Integration tests failed"
    echo "============================================================"
    exit "$EXIT_CODE"
fi

echo
echo "============================================================"
echo "Integration tests passed"
echo "============================================================"

exit 0
