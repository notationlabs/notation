# Cloudflare

`@notation/cloudflare` deploys to Cloudflare. It declares [Workers and Durable Object namespaces](workers.md).

```sh
npm install @notation/cloudflare
```

## Credentials

Deploy reads two environment variables:

- `CLOUDFLARE_API_TOKEN`: an API token with the permissions for what the app deploys:
  - Workers and Durable Objects: **Workers Scripts: Edit**
  - KV namespaces: **Workers KV Storage: Edit**
  - R2 buckets: **Workers R2 Storage: Edit**
  - Containers: **Containers: Edit**
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to. It is stored in state. See [Credentials](workers.md#credentials) for what that means for Workers.
