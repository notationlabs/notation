import type { DocsSite } from "@notation/docs";

const root = new URL(".", import.meta.url);

export const deploy = {
  slug: "deploy",
  label: "Deploy",
  root,
  defaultSlug: "manual/introduction",
  version: { packageJson: "packages/core/package.json" },
  categories: [
    {
      label: "User Manual",
      slug: "manual",
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [
            { label: "Introduction", slug: "manual/introduction" },
            { label: "Installation", slug: "manual/installation" },
            { label: "Quick Start", slug: "manual/quickstart" },
          ],
        },
        {
          heading: "Handlers",
          icon: "cpu",
          links: [
            { label: "Lambda Handlers", slug: "manual/functions" },
            { label: "Lambda Declaration", slug: "manual/function-config" },
          ],
        },
        {
          heading: "Concepts",
          icon: "layers",
          links: [
            { label: "Project Config", slug: "manual/project-config" },
            { label: "File Conventions", slug: "manual/file-conventions" },
            { label: "End-to-End Types", slug: "manual/types" },
          ],
        },
        {
          heading: "Embedding",
          icon: "layers",
          links: [{ label: "Embedded Reconciler", slug: "manual/reconciler" }],
        },
      ],
    },
    {
      label: "CLI",
      slug: "cli",
      sections: [
        {
          heading: "Commands",
          icon: "terminal",
          links: [
            { label: "notation compile", slug: "cli/compile" },
            { label: "notation watch", slug: "cli/watch" },
            { label: "notation plan", slug: "cli/plan" },
            { label: "notation deploy", slug: "cli/deploy" },
            { label: "notation destroy", slug: "cli/destroy" },
            { label: "notation dashboard", slug: "cli/dashboard" },
            { label: "notation viz", slug: "cli/viz" },
          ],
        },
      ],
    },
    {
      label: "Cloud Providers",
      slug: "providers",
      sections: [
        {
          heading: "AWS",
          icon: "cloud",
          links: [
            { label: "Lambda", slug: "resources/lambda" },
            { label: "API Gateway", slug: "resources/api-gateway" },
            { label: "EventBridge", slug: "resources/event-bridge" },
            { label: "SQS", slug: "resources/sqs" },
          ],
        },
        {
          heading: "Resource SDK",
          icon: "layers",
          links: [{ label: "Resource", slug: "internals/resource" }],
        },
      ],
    },
    {
      label: "Internals",
      slug: "internals",
      sections: [
        {
          heading: "Architecture",
          icon: "layers",
          links: [
            { label: "Compiler", slug: "internals/compiler" },
            { label: "Reconciler", slug: "internals/reconciler" },
            { label: "State", slug: "internals/state" },
          ],
        },
      ],
    },
  ],
} satisfies DocsSite;
