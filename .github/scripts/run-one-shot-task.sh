#!/usr/bin/env bash
set -euo pipefail

node scripts/check-operation.mjs

stage="${1:?stage is required}"
role="${2:?role is required (migrate, verify, lifecycle, lifecycle-fixture, tester-cleanup, or task-audit)}"
image_digest="${3:?image digest is required}"
service_commit="${4:?service commit is required}"
verify_api_url="${5:-}"
lifecycle_payload="${6:-}"

[[ "$stage" =~ ^(beta|prod)$ ]] || { echo "Unsupported stage: $stage" >&2; exit 2; }
[[ "$role" =~ ^(migrate|verify|lifecycle|tester-cleanup|lifecycle-fixture|task-audit)$ ]] || { echo "Unsupported role: $role" >&2; exit 2; }
if [[ "$role" == "lifecycle-fixture" ]]; then
  [[ "$stage" == "beta" && "$verify_api_url" =~ ^(prepare-abort|prepare-pause|verify|verify-sentinel|restoration-plan|cleanup)$
    && "$lifecycle_payload" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]] \
    || { echo "Lifecycle fixture requires Beta, an exact operation, and a GitHub run-attempt scope" >&2; exit 2; }
elif [[ "$role" == "task-audit" ]]; then
  [[ "$stage" == "beta" && -z "$verify_api_url" ]] || { echo "Task audit only supports beta with an empty fifth argument" >&2; exit 2; }
  jq -e --arg payload "$lifecycle_payload" '($payload | utf8bytelength) <= 4096 and type == "object"
    and (.runScope | type == "string" and test("^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$"))
    and (if .mode == "window-preflight" then (keys | sort) == ["mode","runScope"]
      else (keys | sort) == ["idempotencyKey","itemId","runScope","taskId","user"]
        and (.user | type == "object" and (keys | sort) == ["email","sub"])
        and ([.taskId,.itemId,.user.sub] | all(.[]; type == "string"
          and test("^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$")))
        and (.idempotencyKey | type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
        and (. as $r | .user.email | type == "string"
          and test("^e2e-beta-" + $r.runScope + "-[0-7]-[a-f0-9]{8}@anywear\\.local$")
          and (split("@")[0] | length <= 64)) end)' \
    <<<"$lifecycle_payload" >/dev/null 2>&1 \
    || { echo "Task audit requires a bounded exact identity/task JSON payload" >&2; exit 2; }
elif [[ "$role" == "tester-cleanup" ]]; then
  [[ "$stage" == "beta" && -z "$verify_api_url" ]] || { echo "Tester cleanup only supports beta with an empty fifth argument" >&2; exit 2; }
  jq -e --arg payload "$lifecycle_payload" '($payload | utf8bytelength) <= 16384 and type == "object"
    and (.runScope | type == "string") and (.users | type == "array" and length <= 50)' \
    <<<"$lifecycle_payload" >/dev/null 2>&1 \
    || { echo "Tester cleanup requires a bounded run scope and exact user JSON payload" >&2; exit 2; }
elif [[ "$role" == "lifecycle" ]]; then
  [[ "$stage" == "beta" ]] || { echo "Lifecycle only supports beta" >&2; exit 2; }
  # #213 retired the admission mode, so the surviving lifecycle actions are the
  # tester allowlist read and its one write. #321 adds the one fenced repair of an
  # abandoned object-deletion manifest; it registers a different Service entry
  # point and its exact payload is validated below.
  [[ "$verify_api_url" =~ ^(status|set-testers|rearm-object-deletion)$ ]] || { echo "Invalid lifecycle action" >&2; exit 2; }
  if [[ "$verify_api_url" == "set-testers" ]]; then
    jq -e --arg payload "$lifecycle_payload" \
      '($payload | utf8bytelength) <= 4096 and type == "array" and length <= 50 and all(.[]; type == "string")' \
      <<<"$lifecycle_payload" >/dev/null 2>&1 \
      || { echo "Tester list must be a JSON array of at most 50 email strings within 4096 bytes" >&2; exit 2; }
  elif [[ "$verify_api_url" == "rearm-object-deletion" ]]; then
    # Issue #321: the re-arm argument is one JSON object with exactly a UUID
    # `manifest_id` and a positive-integer `expected_generation`, and nothing else.
    # It is refused here, before any task definition is registered.
    jq -e --arg payload "$lifecycle_payload" \
      '($payload | utf8bytelength) <= 4096 and type == "object"
        and (keys | sort) == ["expected_generation","manifest_id"]
        and (.manifest_id | type == "string"
          and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))
        and (.expected_generation | type == "number" and . >= 1 and . == floor and . <= 9007199254740991)' \
      <<<"$lifecycle_payload" >/dev/null 2>&1 \
      || { echo "Re-arm requires one JSON object with a UUID manifest_id and a positive-integer expected_generation" >&2; exit 2; }
  elif [[ -n "$lifecycle_payload" ]]; then
    # `status` takes no payload: a stray payload would widen the registered
    # lifecycle command.
    echo "Only set-testers and rearm-object-deletion accept a lifecycle payload; status takes none" >&2
    exit 2
  fi
elif [[ "$role" == "verify" ]]; then
  # #194: the verify role carries either the existing deployment-verification URL
  # or the read-only schema-journal action. The action is not a URL and must not
  # become VERIFY_API_URL; anything else refuses before a task is registered.
  [[ -z "$lifecycle_payload" ]] || { echo "Verify takes no payload" >&2; exit 2; }
  [[ -z "$verify_api_url" || "$verify_api_url" == "schema-journal" || "$verify_api_url" =~ ^https://[^[:space:]]+$ ]] \
    || { echo "Verify requires an https:// VERIFY_API_URL or the schema-journal action" >&2; exit 2; }
elif [[ -n "$lifecycle_payload" ]]; then
  echo "Only lifecycle, tester-cleanup, and task-audit accept a payload" >&2
  exit 2
fi
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid image digest" >&2; exit 2; }
[[ "$service_commit" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid service commit" >&2; exit 2; }
# scripts/runtime-operation.mjs rejects the experimental RUNTIME_DRILL_* and
# LIFECYCLE_EVIDENCE_* scopes before spawning this script, so the only run-scope
# sources are the lifecycle-fixture and task-audit payloads below.
cost_run_scope=""
if [[ "$role" == "lifecycle-fixture" ]]; then
  [[ -z "$cost_run_scope" || "$cost_run_scope" == "$lifecycle_payload" ]] \
    || { echo "Lifecycle fixture scope does not match its payload" >&2; exit 2; }
  cost_run_scope="$lifecycle_payload"
fi
if [[ -n "$cost_run_scope" ]]; then
  [[ "$stage" == "beta" && "$role" =~ ^(migrate|verify|lifecycle|lifecycle-fixture)$
    && "$cost_run_scope" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}$ ]] \
    || { echo "Invalid lifecycle evidence run scope" >&2; exit 2; }
fi

runtime_run_scope=""
if [[ "$stage" == "beta" && ( "$role" == "task-audit" || "$role" == "lifecycle" || "$role" == "tester-cleanup" ) ]]; then
  runtime_run_scope=""
  if [[ "$role" == "task-audit" ]]; then
    payload_scope="$(jq -er '.runScope' <<<"$lifecycle_payload")"
    [[ -z "$runtime_run_scope" || "$runtime_run_scope" == "$payload_scope" ]] || { echo "Audit run scope does not match its payload" >&2; exit 2; }
    runtime_run_scope="$payload_scope"
  fi
  [[ -z "$runtime_run_scope" || "$runtime_run_scope" =~ ^[1-9][0-9]{0,19}-[1-9][0-9]{0,5}-[a-f0-9]{16}$ ]] \
    || { echo "Invalid runtime one-shot run scope" >&2; exit 2; }
fi

if [[ -n "$cost_run_scope" && -n "$runtime_run_scope" ]]; then
  echo "Lifecycle evidence and runtime scopes cannot be combined" >&2
  exit 2
fi

platform_stack="AnyWearPlatformStack-${stage}"
stack_outputs="$(aws cloudformation describe-stacks \
  --stack-name "$platform_stack" \
  --query 'Stacks[0].Outputs' \
  --output json)"

output() {
  jq -er --arg key "$1" '.[] | select(.OutputKey == $key) | .OutputValue' <<<"$stack_outputs"
}

repository_uri="$(output ServiceRepositoryUri)"
cluster_name="$(output EcsClusterName)"
subnet_ids="$(output PrivateSubnetIds)"
security_group_id="$(output OneShotSecurityGroupId)"
if [[ "$role" == "migrate" ]]; then
  task_role_arn="$(output MigrationTaskRoleArn)"
elif [[ "$role" == "tester-cleanup" ]]; then
  task_role_arn="$(output CleanupTaskRoleArn)"
elif [[ "$role" == "lifecycle" || "$role" == "lifecycle-fixture" ]]; then
  task_role_arn="$(output LifecycleTaskRoleArn)"
else
  task_role_arn="$(output VerificationTaskRoleArn)"
fi
execution_role_arn="$(output OneShotExecutionRoleArn)"
log_group="$(output OneShotLogGroupName)"
database_secret_arn="$(output DatabaseSecretArn)"
database_host="$(output DatabaseHost)"
database_port="$(output DatabasePort)"
database_name="$(output DatabaseName)"
bucket_name="$(output WardrobeBucketName)"
vto_queue_url="$(output VtoQueueUrl)"
tagging_queue_url="$(output AutoTaggingQueueUrl)"
vto_dlq_url=""
tagging_dlq_url=""
if [[ "$role" == "lifecycle" || "$role" == "tester-cleanup" || "$role" == "lifecycle-fixture" ]]; then
  vto_dlq_url="$(output VtoDlqUrl)"
  tagging_dlq_url="$(output AutoTaggingDlqUrl)"
fi
image="${repository_uri}@${image_digest}"
command="dist/${role}.js"
if [[ "$role" == "lifecycle" ]]; then
  # #321: the re-arm registers the Service's own object-deletion entry point;
  # every other lifecycle action keeps the beta-lifecycle entry point.
  if [[ "$verify_api_url" == "rearm-object-deletion" ]]; then
    command="dist/ops/object-deletion-rearm.js"
  else
    command="dist/ops/beta-lifecycle.js"
  fi
elif [[ "$role" == "tester-cleanup" ]]; then
  command="dist/ops/beta-tester-cleanup.js"
elif [[ "$role" == "lifecycle-fixture" ]]; then
  command="dist/ops/beta-lifecycle-fixture.js"
elif [[ "$role" == "task-audit" ]]; then
  command="dist/ops/beta-task-audit.js"
fi

environment="$(jq -n \
  --arg stage "$stage" \
  --arg region "$AWS_REGION" \
  --arg secret "$database_secret_arn" \
  --arg host "$database_host" \
  --arg port "$database_port" \
  --arg database "$database_name" \
  --arg bucket "$bucket_name" \
  --arg vto "$vto_queue_url" \
  --arg tagging "$tagging_queue_url" \
  --arg vtoDlq "$vto_dlq_url" \
  --arg taggingDlq "$tagging_dlq_url" \
  --arg commit "$service_commit" \
  --arg digest "$image_digest" \
  --arg api "$verify_api_url" \
  --arg role "$role" \
  --arg actor "${GITHUB_ACTOR:-unknown-actor}" \
  --arg runId "${GITHUB_RUN_ID:-unknown-run}" \
  '[
    {name:"STAGE",value:$stage},
    {name:"NODE_ENV",value:"production"},
    {name:"AWS_REGION",value:$region},
    {name:"DB_SECRET_ARN",value:$secret},
    {name:"DB_HOST",value:$host},
    {name:"DB_PORT",value:$port},
    {name:"DB_NAME",value:$database},
    {name:"S3_BUCKET_NAME",value:$bucket},
    {name:"TASK_TRANSPORT",value:"sqs"},
    {name:"SQS_VTO_QUEUE_URL",value:$vto},
    {name:"SQS_AUTO_TAGGING_QUEUE_URL",value:$tagging},
    {name:"SERVICE_COMMIT_SHA",value:$commit},
    {name:"IMAGE_DIGEST",value:$digest}
  ] + (if $role == "verify" and $api != "" and $api != "schema-journal" then [{name:"VERIFY_API_URL",value:$api}] else [] end)
    + (if $role == "lifecycle" or $role == "tester-cleanup" then [{name:"SQS_VTO_DLQ_URL",value:$vtoDlq},{name:"SQS_AUTO_TAGGING_DLQ_URL",value:$taggingDlq}] else [] end)
    # #321: the re-arm's `last_rearmed_by` is the reviewed dispatch's actor and run
    # id, so the Service can attribute the repair to a person and an audited run.
    + (if $role == "lifecycle" and $api == "rearm-object-deletion" then [{name:"GITHUB_ACTOR",value:$actor},{name:"GITHUB_RUN_ID",value:$runId}] else [] end)')"

family="${stage}-anywear-${role}"
task_definition="$(jq -n \
  --arg family "$family" \
  --arg taskRoleArn "$task_role_arn" \
  --arg executionRoleArn "$execution_role_arn" \
  --arg image "$image" \
  --arg command "$command" \
  --arg action "$verify_api_url" \
  --arg payload "$lifecycle_payload" \
  --arg role "$role" \
  --arg logGroup "$log_group" \
  --arg region "$AWS_REGION" \
  --argjson environment "$environment" \
  '{
    family:$family,
    taskRoleArn:$taskRoleArn,
    executionRoleArn:$executionRoleArn,
    networkMode:"awsvpc",
    requiresCompatibilities:["FARGATE"],
    cpu:"512",
    memory:"1024",
    containerDefinitions:[{
      name:"OneShot",
      image:$image,
      essential:true,
      command:(["node",$command] + (if ($role == "lifecycle" and $action != "rearm-object-deletion") or $role == "lifecycle-fixture" then [$action] else [] end)
        + (if $role == "verify" and $action == "schema-journal" then ["schema-journal"] else [] end)
        + (if ($role == "lifecycle" and $action == "set-testers") or ($role == "lifecycle" and $action == "rearm-object-deletion") or $role == "tester-cleanup" or $role == "lifecycle-fixture" or $role == "task-audit" then [$payload] else [] end)),
      environment:$environment,
      logConfiguration:{
        logDriver:"awslogs",
        options:{
          "awslogs-group":$logGroup,
          "awslogs-region":$region,
          "awslogs-stream-prefix":$family
        }
      }
    }]
  }')"

tag_arguments=()
if [[ -n "$runtime_run_scope" ]]; then
  tag_arguments=(--tags "$(jq -n --arg scope "$runtime_run_scope" '[{key:"anywear-runtime-run-scope",value:$scope}]')")
elif [[ -n "$cost_run_scope" ]]; then
  tag_arguments=(--tags "$(jq -n --arg scope "$cost_run_scope" '[{key:"anywear-lifecycle-evidence-run-scope",value:$scope}]')")
fi
task_definition_arn="$(aws ecs register-task-definition \
  --cli-input-json "$task_definition" \
  "${tag_arguments[@]}" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"
echo "Task definition: $task_definition_arn"

started_by="github-${GITHUB_RUN_ID:-manual}"
task_arn="$(aws ecs run-task \
  --cluster "$cluster_name" \
  --launch-type FARGATE \
  --task-definition "$task_definition_arn" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnet_ids],securityGroups=[$security_group_id],assignPublicIp=DISABLED}" \
  --started-by "$started_by" \
  --query 'tasks[0].taskArn' \
  --output text)"

[[ -n "$task_arn" && "$task_arn" != "None" ]] || { echo "ECS did not start the task" >&2; exit 1; }
echo "Task ARN: $task_arn"
if [[ -n "$runtime_run_scope" ]]; then
  echo "Task log group: $log_group"
  echo "Task log stream: ${family}/OneShot/${task_arn##*/}"
fi
aws ecs wait tasks-stopped --cluster "$cluster_name" --tasks "$task_arn"

task_result="$(aws ecs describe-tasks --cluster "$cluster_name" --tasks "$task_arn" --output json)"
exit_code="$(jq -r '.tasks[0].containers[] | select(.name == "OneShot") | .exitCode // -1' <<<"$task_result")"
stop_reason="$(jq -r '.tasks[0].stoppedReason // "unknown"' <<<"$task_result")"
if [[ -z "$runtime_run_scope" ]]; then
  echo "Task ARN: $task_arn"
  echo "Task definition: $task_definition_arn"
fi
echo "Stopped reason: $stop_reason"

if [[ "$exit_code" != "0" ]]; then
  echo "One-shot task failed with exit code $exit_code" >&2
  exit 1
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "task_arn=$task_arn" >>"$GITHUB_OUTPUT"
  echo "task_definition_arn=$task_definition_arn" >>"$GITHUB_OUTPUT"
fi
