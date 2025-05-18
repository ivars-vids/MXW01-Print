class CatPrinter {
    static MAIN_SERVICE_UUID = 0xae30;
    static PRINT_CHARACTERISTIC_UUID = 0xae01;
    static NOTIFY_CHARACTERISTIC_UUID = 0xae02;
    static DATA_CHARACTERISTIC_UUID = 0xae03;

    static CommandIds = {
        GetStatus: 0xA1,
        PrintIntensity: 0xA2,
        QueryCount: 0xA7,
        Print: 0xA9,
        PrintComplete: 0xAA,
        BatteryLevel: 0xAB,
        CancelPrint: 0xAC,
        PrintDataFlush: 0xAD,
        GetPrintType: 0xB0,
        GetVersion: 0xB1
    };

    static PrintModes = {
        Monochrome: 0x0,
        Grayscale: 0x2
    };

    constructor(statusCB) {
        this.device = null;
        this.server = null;
        this.printCharacteristic = null;
        this.notifyCharacteristic = null;
        this.dataCharacteristic = null;
        this.commandResolvers = new Map();
        this.LINE_PIXELS_COUNT = 384;
        this.eventTarget = new EventTarget();
        this.statusCB = typeof statusCB === 'function' ? statusCB:function(){};
    }

    async connect() {
        try {
            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ name: 'MXW01' }],
                optionalServices: [CatPrinter.MAIN_SERVICE_UUID]
            });
            
            this.server = await this.device.gatt.connect();
            await this.setupCharacteristics();
            this.device.addEventListener('gattserverdisconnected', this.handleDisconnect.bind(this));
            const status = await this.getStatus()
            this.statusCB(`Connected ${status.batteryLevel}% ${status.temperature}\u00b0C`);
            return true;
         } catch (error) {
            this.statusCB(`Connection failed: ${error}`);
            return false;
        }
    }

    handleDisconnect() {
        this.statusCB('Device disconnected');
        this.resetCharacteristics();
        this.dispatchEvent('disconnected');
    }

    resetCharacteristics() {
        this.printCharacteristic = null;
        this.notifyCharacteristic = null;
        this.dataCharacteristic = null;
    }

    async setupCharacteristics() {
        const service = await this.server.getPrimaryService(CatPrinter.MAIN_SERVICE_UUID);
        
        this.printCharacteristic = await service.getCharacteristic(CatPrinter.PRINT_CHARACTERISTIC_UUID);
        this.notifyCharacteristic = await service.getCharacteristic(CatPrinter.NOTIFY_CHARACTERISTIC_UUID);
        this.dataCharacteristic = await service.getCharacteristic(CatPrinter.DATA_CHARACTERISTIC_UUID);

        this.notifyCharacteristic.addEventListener('characteristicvaluechanged', 
            this.handleNotifications.bind(this));
        await this.notifyCharacteristic.startNotifications();
    }

    handleNotifications(event) {
        const value = new Uint8Array(event.target.value.buffer);
        const commandId = value[2];
        
        // Parse notification
        const parsed = this.parseNotification(commandId, value);
        this.dispatchEvent('notification', { commandId, ...parsed });
        
        // Resolve pending command
        const resolver = this.commandResolvers.get(commandId);
        if (resolver) {
            resolver(parsed);
            this.commandResolvers.delete(commandId);
        }
    }

    parseNotification(commandId, data) {
        switch(commandId) {
            case CatPrinter.CommandIds.GetStatus:
                return {
                    batteryLevel: data[9],
                    temperature: data[10],
                    status: data[12],
                    statusDetail: data[13]
                };
                
            case CatPrinter.CommandIds.BatteryLevel:
                return { batteryLevel: data[6] };
                
            case CatPrinter.CommandIds.GetVersion:
                return {
                    version: String.fromCharCode(...data.slice(6, 14)),
                    printerType: data[14]
                };
                
            case CatPrinter.CommandIds.PrintComplete:
                return { success: data[6] === 0 };
                
            default:
                return { rawData: data };
        }
    }

    createCommand(commandId, data) {
        const buffer = new ArrayBuffer(8 + data.length);
        const view = new DataView(buffer);
        
        view.setUint8(0, 0x22);
        view.setUint8(1, 0x21);
        view.setUint8(2, commandId);
        view.setUint8(3, 0x00);
        view.setUint16(4, data.length, true);
        
        new Uint8Array(buffer).set(data, 6);
        view.setUint8(6 + data.length, this.crc8(new Uint8Array(buffer, 0, 6 + data.length)));
        view.setUint8(7 + data.length, 0xFF);
        
        return new Uint8Array(buffer);
    }

    async sendCommand(commandId, data, waitForResponse = true) {
        if (!this.printCharacteristic) await this.setupCharacteristics();
        
        const command = this.createCommand(commandId, data);
        await this.printCharacteristic.writeValueWithoutResponse(command);
        
        if (waitForResponse) {
            return new Promise(resolve => {
                this.commandResolvers.set(commandId, resolve);
            });
        }
    }

    async getStatus() {
        const status = await this.sendCommand(CatPrinter.CommandIds.GetStatus, new Uint8Array([0x00]));
        return status
    }

    async print(imageUrl, intensity = 80, printMode = CatPrinter.PrintModes.Monochrome) {
        intensity = Math.min(intensity, 100);
        
        // Load and process image
        const imageData = await this.loadImageData(imageUrl);
        const bytesPerLine = printMode === CatPrinter.PrintModes.Grayscale ? 
            this.LINE_PIXELS_COUNT / 2 : 
            this.LINE_PIXELS_COUNT / 8;

        this.statusCB('Preparing image')
        const processedImage = this.processImage(imageData, bytesPerLine, printMode);
        const lineCount = processedImage.length / bytesPerLine;

        // Send print commands
        this.statusCB('Printing')
        await this.sendCommand(CatPrinter.CommandIds.PrintIntensity, new Uint8Array([intensity]), false);
        
        const printCommandData = new Uint8Array([
            lineCount & 0xFF,
            (lineCount >> 8) & 0xFF,
            0x30,
            printMode
        ]);
        
        await this.sendCommand(CatPrinter.CommandIds.Print, printCommandData);
        
        // Send image data
        for (let i = 0; i < lineCount; i++) {
            const line = processedImage.slice(i * bytesPerLine, (i + 1) * bytesPerLine);
            await this.dataCharacteristic.writeValueWithoutResponse(line);

        }
        await this.sendCommand(CatPrinter.CommandIds.PrintDataFlush, new Uint8Array([0x00]), false);

        const status = await this.getStatus()
        this.statusCB(`Print finished ${status.batteryLevel}% ${status.temperature}\u00b0C`);
        return this.sendCommand(CatPrinter.CommandIds.PrintComplete, new Uint8Array([0x00]));
    }

    async loadImageData(imageUrl) {
        return new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            
            img.onload = () => {
                canvas.width = this.LINE_PIXELS_COUNT;
                canvas.height = img.height * (this.LINE_PIXELS_COUNT / img.width);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
            };
            
            img.src = imageUrl;
        });
    }

    processImage(imageData, bytesPerLine, printMode) {

        const processed = new Uint8Array(bytesPerLine * imageData.height);
        
        for (let y = 0; y < imageData.height; y++) {
            for (let x = 0; x < this.LINE_PIXELS_COUNT; x++) {
                const idx = (y * this.LINE_PIXELS_COUNT + x) * 4;
                const brightness = 255 - (imageData.data[idx] + imageData.data[idx + 1] +  imageData.data[idx + 2]) / 3;
                
                let oldVal
                let newVal
                let bitPosition
                if (printMode === CatPrinter.PrintModes.Monochrome) {
                    bitPosition = (x % 8);
                    
                    oldVal = brightness;
                    newVal = oldVal < 128 ? 0 : 255;
                }
                else {
                    bitPosition = 4 - (x % 2) * 4;

                    oldVal = brightness;
                    newVal = Math.min(Math.max(Math.round(oldVal / 16) * 16, 0), 255);
                }
                const error = oldVal - newVal;

                    // Distribute error to neighboring pixels
                    let tempVal = (imageData.data[idx + 4] + imageData.data[idx + 5] + imageData.data[idx + 6]) / 3 - Math.floor(error * (7 / 16));
                    tempVal = Math.min(Math.max(tempVal, 0), 255)
                    imageData.data[idx + 4] = tempVal;
                    imageData.data[idx + 5] = tempVal;
                    imageData.data[idx + 6] = tempVal;

                    tempVal = (imageData.data[idx + imageData.width * 4 -4 + 4] + imageData.data[idx + imageData.width * 4 -4 + 5] + imageData.data[idx + imageData.width * 4 -4 + 6]) / 3 
                       - Math.floor(error * (3 / 16));
                    tempVal = Math.min(Math.max(tempVal, 0), 255)
                    imageData.data[idx + imageData.width * 4 -4 + 4] = tempVal
                    imageData.data[idx + imageData.width * 4 -4 + 5] = tempVal
                    imageData.data[idx + imageData.width * 4 -4 + 6] = tempVal

                    tempVal = (imageData.data[idx + imageData.width * 4 + 4] + imageData.data[idx + imageData.width * 4 + 5] + imageData.data[idx + imageData.width * 4 + 6]) / 3
                       - Math.floor(error * (5 / 16));
                    tempVal = Math.min(Math.max(tempVal, 0), 255)
                    imageData.data[idx + imageData.width * 4 + 4] = tempVal
                    imageData.data[idx + imageData.width * 4 + 5] = tempVal
                    imageData.data[idx + imageData.width * 4 + 6] = tempVal

                    tempVal = (imageData.data[idx + imageData.width * 4 +4 + 4] + imageData.data[idx + imageData.width * 4 +4 + 5] + imageData.data[idx + imageData.width * 4 +4 + 6]) / 3
                       - Math.floor(error * (1 / 16));
                    tempVal = Math.min(Math.max(tempVal, 0), 255)
                    imageData.data[idx + imageData.width * 4 + 4 + 4] = tempVal
                    imageData.data[idx + imageData.width * 4 + 4 + 5] = tempVal
                    imageData.data[idx + imageData.width * 4 + 4 + 6] = tempVal

                if (printMode === CatPrinter.PrintModes.Monochrome) {
                    if (newVal > 127) {
                        processed[y * bytesPerLine + Math.floor(x/8)] |= (1 << bitPosition);
                    }
                } else { // Grayscale
                    const bitPosition = 4 - (x % 2) * 4;
                    processed[y * bytesPerLine  + Math.floor(x/2)] |= (((newVal / 16) & 15) << bitPosition);
                    // Implement 4-bit grayscale conversion
                }
            }
        }
        return processed;

    }

    crc8(data) {
        let crc = 0;
        for (const byte of data) {
            crc ^= byte;
            for (let i = 0; i < 8; i++) {
                crc = crc & 0x80 ? (crc << 1) ^ 0x07 : crc << 1;
            }
        }
        return crc & 0xFF;
    }

    // Event handling
    addEventListener(type, callback) {
        this.eventTarget.addEventListener(type, callback);
    }

    dispatchEvent(type, detail = {}) {
        this.eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
