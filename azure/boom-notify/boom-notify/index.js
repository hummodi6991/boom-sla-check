// CommonJS handler so Functions runtime picks it up with function.json
module.exports = async function (context, req) {
  try {
    context.log("boom-notify invoked", { hasBody: !!req.body });
    // TODO: keep/restore your real logic here if needed
    context.res = { status: 200, body: { ok: true } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { ok: false, error: String(err) } };
  }
};
