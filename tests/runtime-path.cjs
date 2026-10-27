module.exports = function runtimePaths(fetchActor) {
  const uids = new Map();
  function observe(result) {
    if (result && typeof result === 'object') {
      for (const actor of result.actors || result.agents || [result]) {
        const metadata = actor.metadata || actor;
        if (metadata.name && metadata.uid && !uids.has(metadata.name)) uids.set(metadata.name, metadata.uid);
      }
    }
    return result;
  }
  const runtimePath = async path => {
    const url = new URL(path, 'https://panel.example');
    const match = /^\/api\/agents\/([^/]+)\/(session|prompt|exec|files|terminal(?:\/.*)?)$/.exec(url.pathname);
    if (!match || url.searchParams.has('uid')) return path;
    const name = decodeURIComponent(match[1]);
    if (!uids.has(name)) observe(await fetchActor(name));
    if (!uids.has(name)) throw new Error(`Sandbox UID unavailable: ${name}`);
    url.searchParams.set('uid', uids.get(name));
    return url.pathname + url.search;
  };
  runtimePath.observe = observe;
  return runtimePath;
};
