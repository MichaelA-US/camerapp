import serverless from "serverless-http";

let cachedHandler = null;

async function getHandler() {
  if (cachedHandler) return cachedHandler;

  const { default: app } = await import("../../src/app.js");
  cachedHandler = serverless(app);
  return cachedHandler;
}

export const handler = async (event, context) => {
  try {
    const fn = await getHandler();
    return await fn(event, context);
  } catch (error) {
    console.error("Netlify function initialization/runtime error:", error);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "Function failed to initialize. Check Netlify Function logs and env vars."
      })
    };
  }
};
