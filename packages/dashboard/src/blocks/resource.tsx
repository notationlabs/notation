import { BaseResource } from "@notation/core";

export function Resource(props: { resource: BaseResource }) {
  return (
    <div className="p-5 px-6">
      <div className="mb-8">
        <div className="text-2xl font-semibold mb-1">
          {getHeading(props.resource)}
        </div>
        <div className="text-xs text-stone-500">
          {getSubHeading(props.resource)}
        </div>
      </div>
      <div className="mb-4 space-y-6">
        <div>
          <a
            href={getConsoleUrl(props.resource)}
            className="text-sm text-white rounded-sm bg-blue-400 p-2"
            target="_blank"
          >
            Open in AWS console→
          </a>
        </div>
        {getMeta(props.resource)}
      </div>
    </div>
  );
}

const getHeading = (resource: BaseResource) => {
  return `${resource.id}`;
};

const getSubHeading = (resource: BaseResource) => {
  return resource.type;
};

const getConsoleUrl = (resource: BaseResource & { output: any }) => {
  if (resource.type.includes("/apiGateway/")) {
    return `https://us-west-2.console.aws.amazon.com/apigateway/main/develop/routes?api=${resource.output.ApiId}&region=us-west-2`;
  }
  return "";
};

const getMeta = (resource: BaseResource & { output: any }) => {
  if (resource.type.includes("/apiGateway/")) {
    return (
      <div>
        <a
          href={resource.output.ApiEndpoint}
          className="text-sm text-blue-500 underline"
          target="_blank"
        >
          {resource.output.ApiEndpoint}
        </a>
      </div>
    );
  }
};
