import type { LambdaResource } from "@notation/aws/lambda/runtime";
import { handle } from "@notation/aws/lambda/runtime";
import { api } from "./utils";

const todos = await api.get<any[]>("/todos");

export const getTodos = handle.apiRequest(() => {
  return todos;
});

export const resource: LambdaResource = {
  service: "aws/lambda",
  id: "todos",
  timeout: 5,
  memory: 64,
};
