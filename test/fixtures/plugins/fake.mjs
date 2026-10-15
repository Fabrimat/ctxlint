// A test plugin covering every matcher kind, an environment check and a broken check.
// Options: { subcommands?: string[] } (default ['build']).
export default (options = {}) => {
  const subcommands = options.subcommands ?? ['build'];
  return {
    name: 'fake',
    apiVersion: 1,
    ignoreRegions: [{ begin: '^<!-- fake:begin', end: '^<!-- fake:end' }],
    checks: [
      {
        id: 'fake/ids',
        description: 'Documented content id does not exist',
        defaultSeverity: 'error',
        match: { inlineCode: /^id:([a-z]+)$/ },
        async verify(claims, ctx) {
          const ids = ((await ctx.readFile('ids.txt')) ?? '').split(/\s+/).filter(Boolean);
          return claims.map((c) =>
            ids.includes(c.groups[0])
              ? { status: 'pass', resolvedFiles: ['ids.txt'] }
              : { status: 'fail', message: `Content id \`${c.groups[0]}\` does not exist` },
          );
        },
      },
      {
        id: 'fake/cli',
        match: { commands: ['fakecli'] },
        verify(claims) {
          return claims.map((c) => {
            const [, sub, ...flags] = c.argv;
            if (!subcommands.includes(sub)) {
              return { status: 'fail', message: `Unknown fakecli command \`${sub}\`` };
            }
            const bad = flags.find((f) => f !== '--x');
            return bad === undefined
              ? { status: 'pass' }
              : { status: 'fail', message: `Unknown flag \`${bad}\``, suggestion: c.value.replace(bad, '--x') };
          });
        },
      },
      {
        id: 'fake/config',
        match: { fences: ['FakeConf'] },
        async verify(claims, ctx) {
          const config = JSON.parse((await ctx.readFile('config.json')) ?? '{}');
          return claims.map((c) => {
            for (const line of c.value.split('\n').filter(Boolean)) {
              const [key, value] = line.split('=');
              if (String(config[key]) !== value) {
                return { status: 'fail', message: `config.json has ${key}=${config[key]}` };
              }
            }
            return { status: 'pass', resolvedFiles: ['config.json'] };
          });
        },
      },
      {
        id: 'fake/env',
        environment: true,
        match: { links: /^fake:(\w+)$/ },
        verify(claims) {
          return claims.map((c) =>
            c.groups[0] === 'ok'
              ? { status: 'pass' }
              : { status: 'fail', message: `fake:${c.groups[0]} is not reachable` },
          );
        },
      },
      {
        id: 'fake/broken',
        match: { inlineCode: /^broken:/ },
        verify(claims) {
          if (claims.some((c) => c.value === 'broken:throw')) throw new Error('boom');
          return claims.map(() => ({ status: 'fail' }));
        },
      },
    ],
  };
};
