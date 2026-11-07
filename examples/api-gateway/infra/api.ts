import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", () => todos);
todoRouter.get("/todos/count", () => todos);
