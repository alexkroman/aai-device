/**
 * Shortest app-catalog search Composio accepts (a shorter one is a 400): the page waits
 * for it and the /apps route never sends less. Its own file so the page imports it
 * without apps.ts, which is server code.
 */
export const MIN_APP_SEARCH = 3;
