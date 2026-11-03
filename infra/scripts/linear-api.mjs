export const LINEAR_URL = 'https://api.linear.app/graphql';

export class Refused extends Error {}

export const linearAsk =
  ({ apiKey, url = LINEAR_URL, fetchImpl }) =>
  async (query, variables) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Refused(`Linear did not answer (${error.name})`);
    }
    const body = await response.json().catch(() => null);
    const error = body?.errors?.[0]?.message;
    if (!response.ok || error || !body?.data) throw new Refused(`Linear answered ${response.status}${error ? `: ${error}` : ''}`);
    return body.data;
  };
