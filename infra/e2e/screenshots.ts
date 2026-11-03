type Env = Record<string, string | undefined>;

const ON_FAILURE = 'only-on-failure';

export function failureScreenshots(env: Env): typeof ON_FAILURE | 'off' {
  return env['JOURNEYS_SCREENSHOTS'] === ON_FAILURE ? ON_FAILURE : 'off';
}
