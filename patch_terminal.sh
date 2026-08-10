# Check if termWs.js is successfully read
FILE="src/websockets/termWs.js"
if [ ! -f "$FILE" ]; then echo "termWs.js not found"; exit 1; fi

# Read the file contents first to see exact structure
cat "$FILE"
