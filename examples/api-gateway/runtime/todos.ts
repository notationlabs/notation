import {
  $lambda,
  apiGateway,
  DecodeError,
  type LambdaHandler,
} from "@notation/aws/lambda";
import { NewTodo } from "./schema";
import { api } from "./utils";

export const lambda = $lambda({
  id: "todos",
  timeout: 5,
  memory: 64,
  event: () => apiGateway.schema(NewTodo),
});

const todos = await api.get<any[]>("/todos");

export const handler: LambdaHandler<typeof lambda> = async (event) => {
  if (event.routeKey === "GET /todos/count") return todos.length;
  if (event.routeKey === "POST /todos") {
    try {
      const todo = await lambda.decode(event);
      return { statusCode: 201, body: JSON.stringify(todo) };
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
      return {
        statusCode: 400,
        body: JSON.stringify({
          errors: error.issues.map((issue) => issue.message),
        }),
      };
    }
  }
  return todos;
};
