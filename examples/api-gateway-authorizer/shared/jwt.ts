import * as v from "valibot";

export const JWTClaims = v.object({
  iss: v.string(),
  sub: v.string(),
  $username: v.string(),
});
