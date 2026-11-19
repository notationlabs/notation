import type { DocsSite } from "@notation/docs";

const root = new URL(".", import.meta.url);

export const deploy = {
  slug: "deploy",
  label: "Deploy",
  root,
  defaultSlug: "core/introduction",
  version: { packageJson: "packages/core/package.json" },
  categories: [
    {
      label: "Core",
      slug: "core",
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [
            { label: "Introduction", slug: "core/introduction" },
            { label: "Quickstart", slug: "core/quickstart" },
          ],
        },
        {
          heading: "Authoring Code",
          icon: "cpu",
          links: [
            { label: "Project Config", slug: "core/project-config" },
            { label: "Modules", slug: "core/modules" },
            { label: "Declarations", slug: "core/declarations" },
            { label: "Types", slug: "core/types" },
          ],
        },
        {
          heading: "Resources",
          icon: "layers",
          links: [
            { label: "Resources", slug: "core/resources" },
            { label: "Physical Names", slug: "core/physical-names" },
            { label: "Resource Wiring", slug: "core/outputs-and-contributions" },
            { label: "Secrets", slug: "core/secrets" },
          ],
        },
        {
          heading: "Reconciler",
          icon: "database",
          links: [
            { label: "Reconciliation", slug: "core/reconciliation" },
            { label: "Recovery", slug: "core/recovery" },
            { label: "State", slug: "core/state" },
          ],
        },
      ],
    },
    {
      label: "CLI",
      slug: "cli",
      sections: [
        {
          heading: "Overview",
          icon: "terminal",
          links: [{ label: "Overview", slug: "cli/overview" }],
        },
        {
          heading: "Deploy",
          icon: "cloud",
          links: [
            { label: "notation deploy", slug: "cli/deploy" },
            { label: "notation plan", slug: "cli/plan" },
            { label: "notation destroy", slug: "cli/destroy" },
          ],
        },
        {
          heading: "Develop",
          icon: "cpu",
          links: [
            { label: "notation watch", slug: "cli/watch" },
            { label: "notation compile", slug: "cli/compile" },
          ],
        },
        {
          heading: "Inspect",
          icon: "layers",
          links: [
            { label: "notation dashboard", slug: "cli/dashboard" },
            { label: "notation viz", slug: "cli/viz" },
          ],
        },
      ],
    },
    {
      label: "Authoring",
      slug: "authoring",
      sections: [
        {
          heading: "Resource SDK",
          icon: "layers",
          links: [
            { label: "Resources", slug: "authoring/resources" },
            { label: "Credential Sources", slug: "authoring/credential-sources" },
          ],
        },
        {
          heading: "Build SDK",
          icon: "cpu",
          links: [
            { label: "Bundles", slug: "authoring/bundles" },
            { label: "Compiler Marks", slug: "authoring/compiler" },
          ],
        },
      ],
    },
    {
      label: "Reference",
      slug: "reference",
      sections: [
        {
          heading: "Core",
          icon: "layers",
          links: [
            { label: "Project Config", slug: "reference/project-config" },
            { label: "Module Boundaries", slug: "reference/module-boundaries" },
            { label: "References", slug: "reference/references" },
            { label: "Type System", slug: "reference/type-system" },
            { label: "Physical Names", slug: "reference/physical-names" },
          ],
        },
        {
          heading: "CLI",
          icon: "terminal",
          links: [
            { label: "CLI Flags", slug: "reference/cli-flags" },
            { label: "Plan Schema", slug: "reference/plan-schema" },
            { label: "Embedded Runtime", slug: "reference/embedded-runtime" },
          ],
        },
        {
          heading: "Authoring SDK",
          icon: "cpu",
          links: [
            { label: "Resource SDK", slug: "reference/resource-sdk" },
            { label: "Credential SDK", slug: "reference/credential-sdk" },
            { label: "Bundles SDK", slug: "reference/bundles-sdk" },
            { label: "Compiler Marks", slug: "reference/compiler-marks" },
          ],
        },
      ],
    },
    {
      label: "Internals",
      slug: "internals",
      sections: [
        {
          heading: "Overview",
          icon: "layers",
          links: [{ label: "Architecture", slug: "internals/architecture" }],
        },
        {
          heading: "Compiler",
          icon: "cpu",
          links: [
            { label: "Module Analysis", slug: "internals/module-analysis" },
            { label: "Transforms", slug: "internals/transforms" },
            { label: "Bundle Cache", slug: "internals/bundle-cache" },
          ],
        },
        {
          heading: "Resources",
          icon: "layers",
          links: [
            { label: "Resource Graph", slug: "internals/resource-graph" },
            { label: "References", slug: "internals/references" },
            { label: "Contributions", slug: "internals/contributions" },
            { label: "Validation", slug: "internals/validation" },
            { label: "Physical Names", slug: "internals/physical-names" },
          ],
        },
        {
          heading: "Reconciler",
          icon: "cpu",
          links: [
            { label: "Planner", slug: "internals/planner" },
            { label: "Durable Execution", slug: "internals/durable-execution" },
            { label: "Recovery", slug: "internals/recovery" },
          ],
        },
        {
          heading: "Storage",
          icon: "database",
          links: [
            { label: "State Store", slug: "internals/state-store" },
            { label: "Secrets Engine", slug: "internals/secrets-engine" },
          ],
        },
        {
          heading: "Tooling",
          icon: "terminal",
          links: [
            { label: "Watch Runner", slug: "internals/watch-runner" },
            { label: "Event Protocol", slug: "internals/protocol" },
          ],
        },
        {
          heading: "Providers",
          icon: "cloud",
          links: [
            { label: "AWS Internals", slug: "internals/aws-internals" },
            { label: "Cloudflare Internals", slug: "internals/cloudflare-internals" },
            { label: "Infisical Internals", slug: "internals/infisical-internals" },
            { label: "1Password Internals", slug: "internals/1password-internals" },
          ],
        },
      ],
    },
    {
      label: "AWS",
      slug: "aws",
      divider: true,
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [{ label: "Overview", slug: "providers/aws/overview" }],
        },
        {
          heading: "Compute",
          icon: "cpu",
          links: [{ label: "Lambda", slug: "providers/aws/lambda" }],
        },
        {
          heading: "APIs",
          icon: "cloud",
          links: [{ label: "API Gateway", slug: "providers/aws/api-gateway" }],
        },
        {
          heading: "Messaging",
          icon: "layers",
          links: [
            { label: "SQS", slug: "providers/aws/sqs" },
            { label: "EventBridge", slug: "providers/aws/event-bridge" },
          ],
        },
      ],
    },
    {
      label: "Cloudflare",
      slug: "cloudflare",
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [{ label: "Overview", slug: "providers/cloudflare/overview" }],
        },
        {
          heading: "Compute",
          icon: "cpu",
          links: [
            { label: "Workers", slug: "providers/cloudflare/workers" },
            { label: "Durable Objects", slug: "providers/cloudflare/durable-objects" },
            { label: "Containers", slug: "providers/cloudflare/containers" },
          ],
        },
        {
          heading: "Storage",
          icon: "database",
          links: [
            { label: "KV", slug: "providers/cloudflare/kv" },
            { label: "R2", slug: "providers/cloudflare/r2" },
          ],
        },
        {
          heading: "Security",
          icon: "layers",
          links: [{ label: "Secrets", slug: "providers/cloudflare/secrets" }],
        },
      ],
    },
    {
      label: "Secret Providers",
      slug: "secret-providers",
      sections: [
        {
          heading: "Secret Providers",
          icon: "database",
          links: [
            { label: "Infisical", slug: "providers/infisical/sources" },
            { label: "1Password", slug: "providers/1password/sources" },
          ],
        },
      ],
    },
  ],
} satisfies DocsSite;
