import * as v from "valibot";

// API Gateway passes every claim value as a string, so a claim such as `exp`
// is parsed from one.
export const JWTClaims = v.object({
  iss: v.string(),
  exp: v.pipe(v.string(), v.transform(Number)),
  sub: v.string(),
  $username: v.string(),
});
