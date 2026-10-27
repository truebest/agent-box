const assert = require('node:assert/strict');

module.exports = async function authenticateBrowser(context, origin, password) {
  const response = await context.request.post(origin + '/api/auth/login', {
    data: { username: 'admin', password }, headers: { Origin: origin },
  });
  assert.equal(response.status(), 204, 'Browser test sign-in failed');
};
