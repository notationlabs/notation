import type { DocCategory } from "@repo/templates/docs";

export const categories: DocCategory[] = [
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
          { label: "Reconciler", slug: "manual/reconciler" },
        ],
      },
      {
        heading: "Handlers",
        icon: "cpu",
        links: [
          { label: "Lambda Handlers", slug: "manual/functions" },
          { label: "Lambda Config", slug: "manual/function-config" },
        ],
      },
      {
        heading: "Concepts",
        icon: "layers",
        links: [
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
    label: "Resources",
    slug: "resources",
    sections: [
      {
        heading: "AWS",
        icon: "cloud",
        links: [
          { label: "Lambda", slug: "resources/lambda" },
          { label: "API Gateway", slug: "resources/api-gateway" },
          { label: "EventBridge", slug: "resources/event-bridge" },
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
        links: [
          { label: "Compiler", slug: "internals/compiler" },
          { label: "Reconciler", slug: "internals/reconciler" },
          { label: "Resource", slug: "internals/resource" },
          { label: "State", slug: "internals/state" },
        ],
      },
    ],
  },
];
