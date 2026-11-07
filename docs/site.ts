import type { DocsSite } from "@notation/docs";

const root = new URL(".", import.meta.url);

export const compiler = {
  slug: "compiler",
  label: "Infra Compiler",
  root,
  defaultSlug: "manual/quickstart",
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
      label: "Internals",
      slug: "internals",
      sections: [
        {
          heading: "Architecture",
          icon: "layers",
          links: [{ label: "Compiler", slug: "internals/compiler" }],
        },
      ],
    },
  ],
} satisfies DocsSite;

export const reconciler = {
  slug: "reconciler",
  label: "Infra Reconciler",
  root,
  version: { packageJson: "packages/reconciler/package.json" },
  categories: [
    {
      label: "Guide",
      slug: "guide",
      sections: [
        {
          heading: "Getting Started",
          icon: "rocket",
          links: [{ label: "Reconciler", slug: "manual/reconciler" }],
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
            { label: "Reconciler", slug: "internals/reconciler" },
            { label: "State", slug: "internals/state" },
          ],
        },
      ],
    },
  ],
} satisfies DocsSite;

export const providers = {
  slug: "providers",
  label: "Cloud Providers",
  root,
  version: { packageJson: "packages/aws/package.json" },
  categories: [
    {
      label: "AWS",
      slug: "aws",
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
      ],
    },
    {
      label: "Resource SDK",
      slug: "sdk",
      sections: [
        {
          heading: "Resource SDK",
          icon: "layers",
          links: [{ label: "Resource", slug: "internals/resource" }],
        },
      ],
    },
  ],
} satisfies DocsSite;
