// api/_auth.js
// App personal — todos los usuarios tienen acceso completo sin límites

async function isProUser(req) {
  return true;
}

module.exports = { isProUser };
