import { ComarkRenderer } from "@notation/docs/ui/content";
import { Section } from "@notation/docs/ui/layout";
import { Heading, Text } from "@notation/docs/ui/element";
import { comarkComponents } from "@notation/docs/ui/content";
import { Tabs } from "@notation/docs/ui/navigation";
import type { ComarkTree } from "@notation/docs/ui/content";
import { parseSections, createTree } from "./parse-sections";

const frameworks = [
  { value: "cdk", trigger: "CDK" },
  { value: "pulumi", trigger: "Pulumi" },
  { value: "sst", trigger: "SST" },
  { value: "serverless", trigger: "Serverless" },
] as const;

export const Comparison = ({ tree }: { tree: ComarkTree }) => {
  if (!tree) return null;

  const sections = parseSections(tree);

  return (
    <Section className="border-b">
      <div className="bleed-full">
        <div className="page-wrap py-12 md:py-20">
          <div className="max-w-3xl mb-12 lg:mb-16">
            <Heading variant="title" className="mb-6">
              Write less, deploy more.
            </Heading>
            <div className="opacity-70 space-y-4">
              <Text>@todo</Text>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-10 xl:gap-20 items-start">
            <div className="space-y-6">
              <ComparisonLabel>Notation</ComparisonLabel>
              <div className="prose-code:bg-transparent">
                <ComarkRenderer
                  tree={createTree(tree, sections["notation"] || [])}
                  components={comarkComponents}
                />
              </div>
            </div>

            <div className="space-y-6">
              <Tabs
                listClassName="bg-black/2 dark:bg-white/2 border border-line !border-b dark:border-white/8 p-1 rounded-md mb-0 min-h-[44px]"
                triggerClassName="px-3 py-1 text-sm font-bold text-slate-500 dark:text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white"
                contentClassName="prose-code:bg-transparent mt-6"
                items={frameworks.map(({ value, trigger }) => ({
                  value,
                  trigger,
                  content: (
                    <ComarkRenderer
                      tree={createTree(tree, sections[value] || [])}
                      components={comarkComponents}
                    />
                  ),
                }))}
              />
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
};

function ComparisonLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center min-h-[44px]">
      <div className="relative flex items-center bg-black/2 dark:bg-white/2 p-1 rounded-md border border-line dark:border-white/8">
        <div className="absolute inset-1 bg-slate-200 dark:bg-slate-300/12 rounded-[4px]" />
        <div className="relative z-10 px-3 py-1 text-sm font-bold text-slate-900 dark:text-white transition-colors">
          {children}
        </div>
      </div>
    </div>
  );
}
