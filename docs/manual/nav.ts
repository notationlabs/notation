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
};
