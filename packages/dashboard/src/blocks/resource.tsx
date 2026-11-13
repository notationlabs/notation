import type { DashboardResource } from "../hooks/remote-state";

export function Resource(props: { resource: DashboardResource }) {
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
      <RetiredInstances resource={props.resource} />
    </div>
  );
}

const getHeading = (resource: DashboardResource) => {
  return `${resource.id}`;
};

const getSubHeading = (resource: DashboardResource) => {
  return resource.type;
};

const getConsoleUrl = (resource: DashboardResource & { output: any }) => {
  if (resource.type.includes("/apiGateway/")) {
    // The ARN is arn:aws:execute-api:<region>:<account>:<api id>/*/*.
    const region = resource.output.ExecuteApiSourceArn?.split(":")[3];
    if (!region) return "";
    return `https://${region}.console.aws.amazon.com/apigateway/main/develop/routes?api=${resource.output.ApiId}&region=${region}`;
  }
  return "";
};

const getMeta = (resource: DashboardResource & { output: any }) => {
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

// A create-first replace keeps the replaced instance in the record until
// deploy deletes it at the end of the deploy, or the next deploy does.
function RetiredInstances(props: { resource: DashboardResource }) {
  const retired = props.resource.retired ?? [];
  if (retired.length === 0) return null;
  return (
    <div>
      <div className="text-sm font-semibold mb-2">
        Retired instances waiting to be deleted
      </div>
      <ul className="space-y-2">
        {retired.map((instance, index) => (
          <li key={index} className="text-xs">
            <div className="text-stone-500">
              Retired at {instance.retiredAt}
            </div>
            <pre className="bg-stone-100 p-2 overflow-auto">
              {JSON.stringify(instance.output, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
