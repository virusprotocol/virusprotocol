
#!/bin/bash
echo '#!/usr/bin/env node' > dist/bin/virus-protocol.js
cat dist/bin/virus-protocol-temp.js >> dist/bin/virus-protocol.js
chmod +x dist/bin/virus-protocol.js