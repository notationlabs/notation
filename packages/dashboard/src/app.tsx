import { useRemoteState } from "./hooks/remote-state";
import { Header } from "./blocks/header";
import { ResourceList } from "./blocks/resource-list";
import { useEffect, useState } from "react";
import { BaseResource } from "@notation/core";
import { Resource } from "./blocks/resource";

function App() {
  const state = useRemoteState();
  const resources = Object.values(state);
  const [activeResource, setActiveResource] = useState<BaseResource>();

  useEffect(() => {
    if (resources.length > 0 && !activeResource) {
      // todo: remove hack
      const resource =
        resources.find((r) => r.type.includes("/apiGateway/")) ||
        resources[0];
      setActiveResource(resource);
    }
  }, [resources, activeResource]);

  return (
    <div className="flex flex-col w-screen h-screen overflow-hidden bg-neutral-50">
      <Header />
      <div className="flex flex-auto h-full">
        <div className="w-1/4 border-r">
          <ResourceList
            activeResourceId={activeResource?.id}
            resources={resources}
            onClick={(resource) => setActiveResource(resource)}
          />
        </div>
        <div className="w-3/4 h-full">
          {activeResource && <Resource resource={activeResource} />}
        </div>
      </div>
    </div>
  );
}

export default App;
