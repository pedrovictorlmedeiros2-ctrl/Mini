# Imagem base para bots Python hospedados
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git gcc \
 && pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir discord.py aiohttp python-dotenv \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# Usuário não-root
RUN useradd -m -u 1000 botuser
USER botuser
CMD ["python", "main.py"]
