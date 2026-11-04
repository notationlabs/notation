// tsup's dts build loads the TypeScript compiler API, which TypeScript 7 does
// not ship. tsup takes TypeScript as a peer, so it would get the root's 7.1;
// making it a dependency keeps tsup on TypeScript 6. Remove this hook once
// tsup's dts build supports TypeScript 7.
function readPackage(pkg) {
  if (pkg.name === "tsup") {
    delete pkg.peerDependencies?.typescript;
    delete pkg.peerDependenciesMeta?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: "^6.0.3" };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
