import { api, router } from "@notation/aws/api-gateway";
import {
  externalJsLambda,
  externalZipLambda,
  externalPyLambda,
} from "./lambda";

const helloApi = api({ name: "hello-api" });
const helloRouter = router(helloApi);

helloRouter.get("/hello1", { resource: externalJsLambda, export: "handler" });
helloRouter.get("/hello2", { resource: externalZipLambda, export: "handler" });
helloRouter.get("/hello3", { resource: externalPyLambda, export: "handler" });
