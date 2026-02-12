import { api, router } from "@notation/aws/api-gateway";
import {
  externalJsLambda,
  externalZipLambda,
  externalPyLambda,
} from "./lambda";

const helloApi = api({ name: "hello-api" });
const helloRouter = router(helloApi);

helloRouter.get("/hello1", externalJsLambda);
helloRouter.get("/hello2", externalZipLambda);
helloRouter.get("/hello3", externalPyLambda);
