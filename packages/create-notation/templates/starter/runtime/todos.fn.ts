import { json } from "@notation/aws/lambda.fn";
import { lambda } from "@notation/aws/lambda" with { type: "infra" };
import { api } from "./utils";

const { handle } = lambda({ id: "todos", timeout: 5, memory: 64 });

const todos = await api.get<any[]>("/todos");

export const getTodos = handle.apiRequest(() => {
  return json(todos);
});
