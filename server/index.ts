import { app } from "./app";
const PORT = Number(process.env.PORT ?? 3001);

app.listen(PORT, () => {
  console.log(`FourFive backend listening on http://localhost:${PORT}`);
});
