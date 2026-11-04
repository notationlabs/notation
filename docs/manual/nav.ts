import type { DocCategory } from "@notation/docs/config";

export const manual: DocCategory = {
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
        { label: "Function Settings", slug: "manual/function-config" },
        { label: "Reading Infra Values", slug: "manual/infra-values" },
        { label: "Testing Handlers", slug: "manual/testing" },
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
};
