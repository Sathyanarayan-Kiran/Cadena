# Cadena staging activation runbook

This directory is the cloud-agnostic activation boundary for staging. It deploys one
application replica behind HTTPS and expects a managed PostgreSQL database and secret
provider to exist already. It deliberately does not choose AWS, Azure or GCP on behalf of
the platform owner.

## Required managed services

- Kubernetes 1.29+ with an NGINX-compatible ingress controller and cert-manager.
- Managed PostgreSQL 16+ reachable from the cluster over TLS. Enable `pgvector` where the
  provider offers it, although the current schema does not yet require a vector column.
- Multi-zone database availability, point-in-time recovery, at least seven days of retained
  backups, and one documented restore drill before live provider data is admitted.
- A cluster secret manager or External Secrets integration. Do not apply
  `secret.example.yaml`; it is a field-name template only.
- A DNS record for the staging hostname and a cert-manager cluster issuer.

## One-time configuration

1. Replace `staging.cadena.example` in `configmap.yaml` and `ingress.yaml`.
2. Replace the ingress class and certificate issuer if the cluster uses different names.
3. Create the namespace, then create `cadena-staging-secrets` through the secret manager:

   ```bash
   kubectl apply -f deploy/staging/namespace.yaml
   kubectl -n cadena-staging create secret generic cadena-staging-secrets \
     --from-literal=DATABASE_URL='postgresql://...' \
     --from-literal=CADENA_DATABASE_CA_BASE64='...' \
     --from-literal=CADENA_BOOTSTRAP_TOKEN='...'
   ```

   The PostgreSQL URL must not include `sslmode` or certificate query parameters. Cadena
   enforces certificate verification through `CADENA_DATABASE_SSL=verify-full` and the
   optional base64-encoded CA certificate.

4. Store a base64-encoded, staging-only kubeconfig as the protected GitHub environment
   secret `KUBE_CONFIG_STAGING_B64`. Prefer a cloud OIDC integration when the provider has
   been selected; the kubeconfig secret is the portable bootstrap path.
5. Protect the GitHub `staging` environment with an approval rule.

## Deploy and rollback

Run the **Publish and deploy staging** workflow manually. It builds and pushes an immutable
`ghcr.io/<owner>/<repository>:<commit-sha>` image, applies the manifests, updates the image,
and waits for readiness.

Rollback selects a previously verified SHA:

```bash
kubectl -n cadena-staging set image deployment/cadena-api api=ghcr.io/OWNER/REPOSITORY:PREVIOUS_SHA
kubectl -n cadena-staging rollout status deployment/cadena-api --timeout=5m
```

The deployment runs two replicas with a rolling update (`maxUnavailable: 0`, `maxSurge: 1`), so
a deploy never drops below full capacity. This became safe once two formerly process-local
assumptions moved into the database: overlapping connector synchronization is now excluded by an
expiring, heartbeated `integration_connector_sync_leases` row rather than an in-process lock, and
the audit-integrity chain now enforces `UNIQUE (org_id, previous_hash)` (and one genesis per
tenant), so two replicas racing to extend the same tenant's chain cannot both commit — the loser's
insert fails and `appendAuditIntegrityEntry` retries against whichever entry actually won, instead
of silently forking the chain. Scale further by raising `replicas`; nothing else in the deployment
assumes a fixed instance count.

## Operational evidence before connector activation

- `GET /health/live` returns HTTP 200 without database access.
- `GET /health/ready` returns HTTP 200 only after schema initialization and a database query.
- The ingress redirects HTTP to HTTPS and presents a trusted certificate.
- Logs are collected as JSON and include request id, method, path, response status and latency.
- A database restore into an isolated staging database has been timed and recorded.
- A deploy and rollback between two immutable image SHAs has been demonstrated.

Until the managed database, DNS/TLS, secret binding, backup restore and rollback checks are
performed in an actual cloud account, the staging milestone is **implemented but not activated**.
