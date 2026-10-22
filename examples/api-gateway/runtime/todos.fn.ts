import type { LambdaConfig } from "@notation/aws/lambda.fn";
import { handle, json } from "@notation/aws/lambda.fn";
import { api } from "./utils";

const todos = await api.get<any[]>("/todos");

export const getTodos = handle.apiRequest(() => {
  return json(todos);
});

export const getTodoCount = handle.apiRequest(() => {
  return json(todos.length);
});

export const config: LambdaConfig = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
  memory: 64,
};
