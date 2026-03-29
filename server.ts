import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Mock Data Endpoints
  app.get("/api/urban-data", (req, res) => {
    const conditions = ["Clear", "Cloudy", "Rainy", "Stormy"];
    res.json({
      traffic: [
        { zone: "A", density: 40 + Math.random() * 40, status: "normal" },
        { zone: "B", density: 30 + Math.random() * 50, status: "normal" },
        { zone: "C", density: 50 + Math.random() * 30, status: "normal" },
      ],
      weather: {
        temp: 20 + Math.random() * 10,
        rainfall: Math.random() * 5,
        condition: conditions[Math.floor(Math.random() * conditions.length)]
      },
      energy: {
        load: 60 + Math.random() * 30,
        capacity: 100
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
