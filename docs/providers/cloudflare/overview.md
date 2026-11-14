# Cloudflare

`@notation/cloudflare` deploys to Cloudflare. It declares [Workers and Durable Object namespaces](workers.md), [secrets](secrets.md) that Workers bind, and [containers](containers.md) that Durable Object namespaces run.

```sh
npm install @notation/cloudflare
```

Deploy reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See [Credentials](workers.md#credentials).
