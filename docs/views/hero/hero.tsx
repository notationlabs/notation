import { Button } from "@notation/docs/ui/element";
import { GitHub } from "@notation/docs/ui/icon";
import { Section } from "@notation/docs/ui/layout";
import { Heading, Text } from "@notation/docs/ui/element";
import { Link } from "@tanstack/react-router";

export const Hero = () => (
  <Section>
    <div className="bleed-full">
      <div className="page-wrap py-8 md:py-10">
        <div className="lg:flex items-end xl:items-center lg:gap-24">
          <div className="lg:w-2/5">
            <div className="max-w-3xl">
              <Heading as="h1" variant="largeTitle" className="mb-6">
                AWS, in a beat.
              </Heading>
              <div className="space-y-3 lg:space-y-5 opacity-70">
                <Text>
                  Notation is an infrastructure compiler, deployment engine, and resource SDK.
                </Text>
                <Text>Use it to build, launch, and connect serverless services.</Text>
                <Text>
                  No glue code. No dashboard ops.{" "}
                  <span className="italic">You just deploy things.</span>
                </Text>
              </div>
            </div>
            <div className="flex gap-4 mt-9">
              <Button
                as="a"
                href="https://github.com/notationlabs/notation"
                variant="default"
                size="sm"
              >
                <GitHub className="-ml-1 sm:-ml-2.5 w-5 h-5" />
                Github
              </Button>
              <Button as={Link} to="/docs" variant="outline" size="sm">
                Docs →
              </Button>
            </div>
          </div>

          <div className="lg:w-3/5 mt-10 lg:mt-0 ">
            <a
              href="https://www.youtube.com/watch?v=dwS81CVkC88"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img className="rounded-lg aspect-video" src="/assets/video-thumbnail.png" />
            </a>
          </div>
        </div>
      </div>
    </div>
  </Section>
);
