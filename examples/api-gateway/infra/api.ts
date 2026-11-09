import { api, router } from "@notation/aws/api-gateway";
import { lambda as todos } from "runtime/todos";

const todoApi = api({ id: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", () => todos);
todoRouter.get("/todos/count", () => todos);
todoRouter.post("/todos", () => todos);
