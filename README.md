# Virus Protocol Backend

An advanced TypeScript-based backend system implementing the Virus Protocol with sophisticated memory management, context evolution, and blockchain integration capabilities.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Solana](https://img.shields.io/badge/Solana-Integrated-green)](https://solana.com)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT4-purple)](https://openai.com)
[![Docker](https://img.shields.io/badge/Docker-Required-blue)](https://www.docker.com/)

## 🚀 Features

[Previous features section remains the same...]

## 🛠 Prerequisites

- Node.js >= 16.x
- Docker and Docker Compose
- OpenAI API key
- TypeScript 5.0+
- Solana RPC endpoint

Note: Redis and MongoDB are included in the Docker configuration and do not need to be installed separately.

## 📦 Installation

1. **Clone the repository**

```bash
git clone https://github.com/<yourusername>/virus-protocol-backend.git
cd virus-protocol-backend
```

2. **Install dependencies**

```bash
npm install
```

3. **Environment Setup**

```bash
# Create .env file
cp .env.example .env

# Configure your environment variables
OPENAI_API_KEY=your_api_key
SOLANA_RPC_URL=your_solana_rpc_url

# The following variables are pre-configured for Docker:
REDIS_HOST=redis
MONGODB_URI=mongodb://mongodb:27017/virus-protocol
```

4. **Build the project**

```bash
npm run build
```

## 🚀 Running the Service

### Using Docker (Recommended)

```bash
# Build and start all services (Redis, MongoDB, and the application)
docker-compose up -d

# View logs
docker-compose logs -f

# Stop all services
docker-compose down
```

### Development Mode (with Docker)

```bash
# Start Redis and MongoDB containers
docker-compose up redis mongodb -d

# Run the application in development mode
npm run dev
```

### Running the CLI

The CLI requires Redis and MongoDB to be running. You can either:

1. Use Docker (recommended):

```bash
# Start the required services
docker-compose up redis mongodb -d

# Run the CLI
npm run cli
```

2. Or use the Docker network directly:

```bash
# Run the CLI inside the Docker network
docker-compose run --rm app npm run cli
```

## 🏗 Architecture

### Memory System

The memory system is divided into short-term and long-term storage:

```typescript
interface Memory {
  content: string;
  timestamp: Date;
  importance: number;
}

interface ShortTermMemory {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface LongTermMemory extends Memory {
  type: "fact" | "concept" | "pattern";
  lastAccessed: Date;
  accessCount: number;
}
```

### Context Management

Handles dynamic context windows and evolution:

```typescript
interface ContextSummary {
  summary: string;
  timestamp: Date;
  version: number;
  topics: string[];
  keyInsights: string[];
}
```

### Tool System

Extensible tool architecture for blockchain integration:

```typescript
interface Tool {
  name: string;
  description: string;
  execute(args: any): Promise<ToolResult>;
}
```

## 📈 Evolution System

The system implements an evolution mechanism that:

1. Processes interactions through multiple time windows
2. Calculates evolution scores based on:
   - Novelty
   - Complexity
   - Context alignment
   - Knowledge integration
3. Maintains a queue for background processing
4. Updates system context based on learning

## 🔧 Configuration

Key configuration options in `config.ts`:

```typescript
const config = {
  memory: {
    shortTermLimit: 10,
    longTermLimit: 500,
  },
  evolution: {
    timeWindows: [
      { hours: 24, maxInteractions: 50 },
      { hours: 168, maxInteractions: 100 },
      { hours: 720, maxInteractions: 200 },
    ],
  },
  // ... other configurations
};
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- Code style
- Development process
- Pull request procedure
- Testing requirements

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔒 Security

For security concerns, please email security@yourdomain.com. See our [Security Policy](SECURITY.md) for details.

## 🙏 Acknowledgments

- OpenAI for GPT integration
- Solana team for blockchain infrastructure
- MongoDB and Redis teams

## 📞 Contact

- Twitter: [@virusprotocol](https://twitter.com/virus_protocol)
