const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const path = require('node:path');
const fs = require('node:fs');

// Futuristic Cyber Palette from Official Visual Reference:
// Neon Cyan:   #00F0FF
// Neon Blue:   #0077FE
// Neon Purple: #BD00FF
// Cyber Black: #050814
// Cyber Dark:  #080E21
// Chrome White:#FFFFFF
// Chrome Dim:  #64748B
const PALETTE = {
    navy: '#050814',
    sapphire: '#080E21',
    neonCyan: '#00F0FF',
    neonBlue: '#0077FE',
    neonPurple: '#BD00FF',
    warmTaupe: '#64748B',
    champagne: '#00F0FF',
    ivory: '#FFFFFF'
};

const EVENT_DETAILS = {
    title: 'Digital Work AI Exhibition : MENEMBUS BATAS DIGITAL',
    subtitle: 'Kolaborasi Talenta Muda & Artificial Intelligence',
    date: 'Rabu, 11 November 2026',
    time: '10.00 WIB s/d Selesai',
    venue: 'Waroeng Latte',
    address: 'Jl. Cokroaminoto No.88, Kejuron, Pandean, Kec. Taman, Kota Madiun, Jawa Timur 63133'
};

const logoPath = path.join(__dirname, '..', 'public', 'images', 'logo-header.png');

/**
 * Generate consolidated PDF containing an A6 invitation card per institution.
 * NO BARCODE ON THE INVITATIONS - Pure, dignified, futuristic invitation pass.
 * A6 dimensions: 298 x 420 points (105 x 148 mm)
 */
async function generateInvitationsPdf(guests, outputStream) {
    const doc = new PDFDocument({
        size: [298, 420],
        margin: 0,
        autoFirstPage: false
    });

    doc.pipe(outputStream);

    for (let i = 0; i < guests.length; i++) {
        const guest = guests[i];
        doc.addPage();

        // 1. Deep Cyber Black Background
        doc.rect(0, 0, 298, 420).fill(PALETTE.navy);

        // Cyber Double Border in Neon Cyan (#00F0FF) & Neon Purple (#BD00FF)
        doc.strokeColor(PALETTE.neonPurple).lineWidth(0.8);
        doc.rect(12, 12, 274, 396).stroke();
        doc.strokeColor(PALETTE.neonCyan).lineWidth(1.5);
        doc.rect(16, 16, 266, 388).stroke();

        // Corner Tech Reticles
        const drawCornerOrnament = (x, y) => {
            doc.strokeColor(PALETTE.neonCyan).lineWidth(1);
            doc.moveTo(x - 6, y).lineTo(x + 6, y).stroke();
            doc.moveTo(x, y - 6).lineTo(x, y + 6).stroke();
        };
        drawCornerOrnament(22, 22);
        drawCornerOrnament(276, 22);
        drawCornerOrnament(22, 398);
        drawCornerOrnament(276, 398);

        // 2. Top Header Area (With Official 3D Graphic Logo if available)
        if (fs.existsSync(logoPath)) {
            try {
                doc.image(logoPath, 39, 24, { width: 220, align: 'center' });
            } catch (e) {
                doc.font('Helvetica-Bold').fontSize(12).fillColor(PALETTE.neonCyan);
                doc.text(EVENT_DETAILS.title, 20, 32, { align: 'center', width: 258 });
            }
        } else {
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.neonCyan);
            doc.text('OFFICIAL INVITATION PASS • EXHIBITION 2026', 20, 26, { align: 'center', width: 258 });
            doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.ivory);
            doc.text(EVENT_DETAILS.title, 20, 38, { align: 'center', width: 258 });
        }

        // Category Badge
        const badgeY = 82;
        doc.roundedRect(40, badgeY, 218, 18, 9).fill(PALETTE.sapphire);
        doc.strokeColor(PALETTE.neonCyan).lineWidth(0.8).roundedRect(40, badgeY, 218, 18, 9).stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.neonCyan);
        doc.text((guest.category || 'MITRA STRATEGIS').toUpperCase(), 40, badgeY + 4.5, { align: 'center', width: 218 });

        // Divider
        doc.strokeColor(PALETTE.neonPurple).lineWidth(0.5);
        doc.moveTo(35, 108).lineTo(263, 108).stroke();

        // 3. Institution Centerpiece
        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.warmTaupe);
        doc.text('KEPADA YTH. PERWAKILAN INSTANSI / MITRA', 20, 116, { align: 'center', width: 258 });

        doc.font('Helvetica-Bold').fontSize(16).fillColor(PALETTE.ivory);
        doc.text(guest.institution, 20, 130, { align: 'center', width: 258 });

        // 4. Futuristic Invitation Content Box
        const boxY = 162;
        doc.roundedRect(26, boxY, 246, 142, 8).fill(PALETTE.sapphire);
        doc.strokeColor(PALETTE.neonCyan).lineWidth(1).roundedRect(26, boxY, 246, 142, 8).stroke();

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.neonCyan);
        doc.text('UNDANGAN RESMI KEHORMATAN', 30, boxY + 12, { align: 'center', width: 238 });

        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.ivory);
        doc.text(
            'Dengan hormat mengundang kehadiran Bapak/Ibu dalam pagelaran karya inovasi dan kolaborasi talenta muda di era Artificial Intelligence.',
            36, boxY + 28, { align: 'center', width: 226, lineGap: 1.5 }
        );

        // Date, Time & Venue in Card
        const schedY = boxY + 68;
        doc.strokeColor(PALETTE.neonPurple).lineWidth(0.5);
        doc.moveTo(40, schedY).lineTo(258, schedY).stroke();

        doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.neonCyan);
        doc.text(`${EVENT_DETAILS.date} • Pukul ${EVENT_DETAILS.time}`, 30, schedY + 8, { align: 'center', width: 238 });

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.ivory);
        doc.text(EVENT_DETAILS.venue, 30, schedY + 22, { align: 'center', width: 238 });

        doc.font('Helvetica').fontSize(7).fillColor(PALETTE.warmTaupe);
        doc.text('Jl. Cokroaminoto No.88, Kejuron, Pandean, Kec. Taman, Kota Madiun', 30, schedY + 36, { align: 'center', width: 238 });

        // 5. Venue Verification Note
        const footerY = 316;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.neonCyan);
        doc.text('VERIFIKASI KEDATANGAN DI VENUE', 20, footerY, { align: 'center', width: 258 });

        doc.font('Helvetica').fontSize(6.8).fillColor(PALETTE.warmTaupe);
        doc.text(
            'Kartu fisik ini tidak memerlukan barcode pribadi. Cukup bawa undangan ini dan pindai 1 Master Barcode di Meja Registrasi Waroeng Latte.',
            26, footerY + 12, { align: 'center', width: 246, lineGap: 1 }
        );

        doc.strokeColor(PALETTE.neonCyan).lineWidth(0.4);
        doc.moveTo(40, footerY + 44).lineTo(258, footerY + 44).stroke();

        // 6. Security & Token Footer
        doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.neonCyan);
        doc.text(guest.qr_token || 'MBD-2026', 20, footerY + 52, { align: 'center', width: 258 });

        doc.font('Helvetica').fontSize(5.5).fillColor(PALETTE.warmTaupe);
        doc.text('WAROENG LATTE MADIUN • DIGITAL WORK AI EXHIBITION 2026', 20, footerY + 66, { align: 'center', width: 258 });
    }

    doc.end();
}

/**
 * Generate 1 High-Resolution Master Barcode Standee (A4 Format) for Venue Reception
 * Size: A4 = 595.28 x 841.89 points
 */
async function generateVenueStandeePdf(checkinUrl, outputStream) {
    const doc = new PDFDocument({
        size: 'A4',
        margin: 0
    });

    doc.pipe(outputStream);

    // Deep Cyber Black Background
    doc.rect(0, 0, 595.28, 841.89).fill(PALETTE.navy);

    // Futuristic Neon Double Border
    doc.strokeColor(PALETTE.neonPurple).lineWidth(1.5);
    doc.rect(25, 25, 545.28, 791.89).stroke();
    doc.strokeColor(PALETTE.neonCyan).lineWidth(2.5);
    doc.rect(32, 32, 531.28, 777.89).stroke();

    // Corner Ornaments
    const drawBigOrnament = (x, y) => {
        doc.strokeColor(PALETTE.neonCyan).lineWidth(1.5);
        doc.moveTo(x - 10, y).lineTo(x + 10, y).stroke();
        doc.moveTo(x, y - 10).lineTo(x, y + 10).stroke();
    };
    drawBigOrnament(44, 44);
    drawBigOrnament(551, 44);
    drawBigOrnament(44, 797);
    drawBigOrnament(551, 797);

    // Top Header with Official 3D Graphic Logo
    if (fs.existsSync(logoPath)) {
        try {
            doc.image(logoPath, 137, 46, { width: 320, align: 'center' });
        } catch (e) {
            doc.font('Helvetica-Bold').fontSize(22).fillColor(PALETTE.neonCyan);
            doc.text(EVENT_DETAILS.title, 40, 68, { align: 'center', width: 515.28 });
        }
    } else {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.warmTaupe);
        doc.text('OFFICIAL GUESTBOOK CHECK-IN • EXHIBITION 2026', 40, 56, { align: 'center', width: 515.28 });
        doc.font('Helvetica-Bold').fontSize(22).fillColor(PALETTE.neonCyan);
        doc.text(EVENT_DETAILS.title, 40, 78, { align: 'center', width: 515.28 });
    }

    // Venue & Date Ribbon
    doc.roundedRect(70, 136, 455.28, 38, 19).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.neonCyan).lineWidth(1.2).roundedRect(70, 136, 455.28, 38, 19).stroke();
    
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PALETTE.neonCyan);
    doc.text(`${EVENT_DETAILS.date} • Pukul ${EVENT_DETAILS.time}`, 70, 144, { align: 'center', width: 455.28 });
    
    doc.font('Helvetica').fontSize(9).fillColor(PALETTE.ivory);
    doc.text(`${EVENT_DETAILS.venue} • Jl. Cokroaminoto No.88, Taman, Kota Madiun`, 70, 158, { align: 'center', width: 455.28 });

    // Call to Action
    doc.font('Helvetica-Bold').fontSize(14).fillColor(PALETTE.ivory);
    doc.text('SILAKAN PINDAI BARCODE DI BAWAH INI', 40, 196, { align: 'center', width: 515.28 });

    doc.font('Helvetica').fontSize(10.5).fillColor(PALETTE.warmTaupe);
    doc.text('Arahkan kamera smartphone Anda ke barcode ini untuk konfirmasi kehadiran instansi Anda.', 60, 218, {
        align: 'center',
        width: 475.28
    });

    // Generate High-Res Master Barcode / QR Code
    const qrDataUrl = await QRCode.toDataURL(checkinUrl, {
        errorCorrectionLevel: 'H',
        margin: 1,
        width: 600,
        color: {
            dark: '#050814',
            light: '#FFFFFF'
        }
    });

    // Large Centerpiece QR Box
    const qrContainerX = 167;
    const qrContainerY = 255;
    const qrSize = 260;

    // Glowing Neon Frame
    doc.roundedRect(qrContainerX - 8, qrContainerY - 8, qrSize + 16, qrSize + 16, 16).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.neonCyan).lineWidth(2).roundedRect(qrContainerX - 8, qrContainerY - 8, qrSize + 16, qrSize + 16, 16).stroke();
    
    // QR Surface
    doc.roundedRect(qrContainerX, qrContainerY, qrSize, qrSize, 12).fill(PALETTE.ivory);
    doc.image(qrDataUrl, qrContainerX + 10, qrContainerY + 10, { width: qrSize - 20, height: qrSize - 20 });

    // Step-by-Step Instructions
    const stepsY = 548;
    doc.roundedRect(80, stepsY, 435.28, 130, 12).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.neonCyan).lineWidth(0.8).roundedRect(80, stepsY, 435.28, 130, 12).stroke();

    doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.neonCyan);
    doc.text('PANDUAN VERIFIKASI KEDATANGAN DI WAROENG LATTE:', 100, stepsY + 16, { width: 395.28 });

    doc.font('Helvetica').fontSize(9.5).fillColor(PALETTE.ivory);
    doc.text('1. Buka aplikasi kamera smartphone dan arahkan ke barcode di atas.', 100, stepsY + 38, { width: 395.28 });
    doc.text('2. Klik tautan yang muncul untuk membuka Buku Tamu Digital resmi.', 100, stepsY + 58, { width: 395.28 });
    doc.text('3. Pilih nama instansi/perusahaan Anda dan sampaikan sepatah kata ucapan.', 100, stepsY + 78, { width: 395.28 });
    doc.text('4. Nama instansi Anda akan langsung disambut di Layar Utama Pameran!', 100, stepsY + 98, { width: 395.28 });

    // Receptionist Assistance Note
    doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.neonCyan);
    doc.text('Petugas Penerima Tamu Kami di Waroeng Latte Siap Membantu Anda', 40, 706, { align: 'center', width: 515.28 });

    doc.strokeColor(PALETTE.neonPurple).lineWidth(0.5);
    doc.moveTo(100, 735).lineTo(495.28, 735).stroke();

    // Footer
    doc.font('Helvetica').fontSize(8.5).fillColor(PALETTE.warmTaupe);
    doc.text('WAROENG LATTE MADIUN • DIGITAL WORK AI EXHIBITION 2026', 40, 746, { align: 'center', width: 515.28 });

    doc.end();
}

module.exports = {
    generateInvitationsPdf,
    generateVenueStandeePdf,
    PALETTE,
    EVENT_DETAILS
};
