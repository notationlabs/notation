import type { DocCategory } from "@notation/docs/config";

export const cli: DocCategory = {
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
};
