FROM python:3.11-slim
WORKDIR /app
RUN pip install mcp fastmcp
COPY server.py .
EXPOSE 8001
CMD ["python", "server.py"]
