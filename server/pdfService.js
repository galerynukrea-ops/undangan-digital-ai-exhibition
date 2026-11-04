const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// Luxury Palette from Reference:
// Navy Blue:   #112250
// Sapphire:    #3B507D
// Warm Taupe:  #BEB7A7
// Champagne:   #E7E2CE
// Ivory:       #F5F4F0
const PALETTE = {
    navy: '#112250',
    sapphire: '#3B507D',
    warmTaupe: '#BEB7A7',
    champagne: '#E7E2CE',
    ivory: '#F5F4F0'
};

const EVENT_DETAILS = {
    title: 'MENEMBUS BATAS DIGITAL',
    subtitle: 'Kolaborasi Talenta Muda & Artificial Intelligence',
    date: 'Rabu, 11 November 2026',
    time: '10.00 WIB s/d Selesai',
    venue: 'Waroeng Latte',
    address: 'Jl. Cokroaminoto No.88, Kejuron, Pandean, Kec. Taman, Kota Madiun, Jawa Timur 63133'
};

/**
 * Generate consolidated PDF containing an A6 invitation card per institution.
 * NO BARCODE ON THE INVITATIONS - Pure, dignified, formal invitation pass.
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

        // 1. Solid Deep Navy Blue Background (#112250)
        doc.rect(0, 0, 298, 420).fill(PALETTE.navy);

        // Elegant Double Border in Champagne (#E7E2CE) and Warm Taupe (#BEB7A7)
        doc.strokeColor(PALETTE.warmTaupe).lineWidth(0.8);
        doc.rect(12, 12, 274, 396).stroke();
        doc.strokeColor(PALETTE.champagne).lineWidth(1.5);
        doc.rect(16, 16, 266, 388).stroke();

        // Corner Ornamental Crosses
        const drawCornerOrnament = (x, y) => {
            doc.strokeColor(PALETTE.champagne).lineWidth(1);
            doc.moveTo(x - 5, y).lineTo(x + 5, y).stroke();
            doc.moveTo(x, y - 5).lineTo(x, y + 5).stroke();
        };
        drawCornerOrnament(22, 22);
        drawCornerOrnament(276, 22);
        drawCornerOrnament(22, 398);
        drawCornerOrnament(276, 398);

        // 2. Top Header Area
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.warmTaupe);
        doc.text('OFFICIAL INVITATION PASS • EXHIBITION 2026', 20, 28, { align: 'center', width: 258 });

        doc.font('Helvetica-Bold').fontSize(13.5).fillColor(PALETTE.champagne);
        doc.text(EVENT_DETAILS.title, 20, 41, { align: 'center', width: 258 });

        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.ivory);
        doc.text(EVENT_DETAILS.subtitle, 20, 58, { align: 'center', width: 258 });

        // Category Badge
        const badgeY = 72;
        doc.roundedRect(40, badgeY, 218, 18, 9).fill(PALETTE.sapphire);
        doc.strokeColor(PALETTE.champagne).lineWidth(0.8).roundedRect(40, badgeY, 218, 18, 9).stroke();
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.champagne);
        doc.text((guest.category || 'MITRA STRATEGIS').toUpperCase(), 40, badgeY + 4.5, { align: 'center', width: 218 });

        // Divider
        doc.strokeColor(PALETTE.warmTaupe).lineWidth(0.5);
        doc.moveTo(35, 100).lineTo(263, 100).stroke();

        // 3. Institution Centerpiece (Dignified presentation)
        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.warmTaupe);
        doc.text('KEPADA YTH. PERWAKILAN INSTANSI / MITRA', 20, 108, { align: 'center', width: 258 });

        doc.font('Helvetica-Bold').fontSize(17).fillColor(PALETTE.ivory);
        doc.text(guest.institution, 20, 122, { align: 'center', width: 258 });

        // 4. Elegant Official Invitation Content Box (With Waroeng Latte Madiun Details)
        const boxY = 154;
        doc.roundedRect(26, boxY, 246, 142, 8).fill(PALETTE.sapphire);
        doc.strokeColor(PALETTE.champagne).lineWidth(1).roundedRect(26, boxY, 246, 142, 8).stroke();

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.champagne);
        doc.text('UNDANGAN RESMI KEHORMATAN', 30, boxY + 12, { align: 'center', width: 238 });

        doc.font('Helvetica').fontSize(7.5).fillColor(PALETTE.ivory);
        const invitationBody = 'Dengan hormat mengundang kehadiran Bapak/Ibu dalam pagelaran karya inovasi dan kolaborasi talenta muda di era Artificial Intelligence.';
        doc.text(invitationBody, 35, boxY + 28, { align: 'center', width: 228, lineGap: 2.5 });

        doc.strokeColor(PALETTE.warmTaupe).lineWidth(0.5);
        doc.moveTo(45, boxY + 70).lineTo(253, boxY + 70).stroke();

        // Event Schedule & Venue Details
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.champagne);
        doc.text('WAKTU & TEMPAT PELAKSANAAN:', 30, boxY + 76, { align: 'center', width: 238 });

        doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETTE.ivory);
        doc.text(`${EVENT_DETAILS.date} • Pukul ${EVENT_DETAILS.time}`, 30, boxY + 90, { align: 'center', width: 238 });

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PALETTE.champagne);
        doc.text(EVENT_DETAILS.venue, 30, boxY + 104, { align: 'center', width: 238 });

        doc.font('Helvetica').fontSize(6.8).fillColor(PALETTE.warmTaupe);
        doc.text(EVENT_DETAILS.address, 34, boxY + 117, { align: 'center', width: 230, lineGap: 1.5 });

        // 5. Venue Verification Guidance
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETTE.champagne);
        doc.text('VERIFIKASI KEDATANGAN DI VENUE:', 20, 312, { align: 'center', width: 258 });

        doc.font('Helvetica').fontSize(7.2).fillColor(PALETTE.warmTaupe);
        doc.text('Setibanya di Waroeng Latte, silakan memindai Barcode Kedatangan yang tersedia di meja depan bersama petugas penerima tamu untuk mengisi Buku Tamu Digital.', 26, 326, {
            align: 'center',
            width: 246,
            lineGap: 2
        });

        doc.strokeColor(PALETTE.sapphire).lineWidth(0.8);
        doc.moveTo(40, 368).lineTo(258, 368).stroke();

        // Footer details
        doc.font('Helvetica-Bold').fontSize(7).fillColor(PALETTE.champagne);
        doc.text('KOMITE PELAKSANA • DIGITAL AI INNOVATION LAB MADIUN', 20, 376, { align: 'center', width: 258 });
        doc.font('Helvetica').fontSize(6.5).fillColor(PALETTE.warmTaupe);
        doc.text('Tanda masuk resmi kemitraan • Mohon dibawa saat menghadiri pameran', 20, 388, { align: 'center', width: 258 });
    }

    doc.end();
}

/**
 * Generate 1 Master Barcode Standee PDF for the venue front desk / standing banner.
 * Size: Standard A4 (595.28 x 841.89 pt) ready for acrylic standee / banner!
 */
async function generateVenueStandeePdf(checkinUrl, outputStream) {
    const doc = new PDFDocument({
        size: 'A4',
        margin: 0
    });

    doc.pipe(outputStream);

    // Deep Navy Blue Background (#112250)
    doc.rect(0, 0, 595.28, 841.89).fill(PALETTE.navy);

    // Double Border in Champagne (#E7E2CE) and Warm Taupe (#BEB7A7)
    doc.strokeColor(PALETTE.warmTaupe).lineWidth(1.5);
    doc.rect(25, 25, 545.28, 791.89).stroke();
    doc.strokeColor(PALETTE.champagne).lineWidth(2.5);
    doc.rect(32, 32, 531.28, 777.89).stroke();

    // Corner Ornaments
    const drawBigOrnament = (x, y) => {
        doc.strokeColor(PALETTE.champagne).lineWidth(1.5);
        doc.moveTo(x - 10, y).lineTo(x + 10, y).stroke();
        doc.moveTo(x, y - 10).lineTo(x, y + 10).stroke();
    };
    drawBigOrnament(44, 44);
    drawBigOrnament(551, 44);
    drawBigOrnament(44, 797);
    drawBigOrnament(551, 797);

    // Header Badge
    doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.warmTaupe);
    doc.text('OFFICIAL GUESTBOOK CHECK-IN • EXHIBITION 2026', 40, 56, { align: 'center', width: 515.28 });

    doc.font('Helvetica-Bold').fontSize(25).fillColor(PALETTE.champagne);
    doc.text(EVENT_DETAILS.title, 40, 78, { align: 'center', width: 515.28 });

    doc.font('Helvetica').fontSize(12).fillColor(PALETTE.ivory);
    doc.text(EVENT_DETAILS.subtitle, 40, 110, { align: 'center', width: 515.28 });

    // Venue & Date Ribbon
    doc.roundedRect(70, 136, 455.28, 38, 19).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.champagne).lineWidth(1.2).roundedRect(70, 136, 455.28, 38, 19).stroke();
    
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(PALETTE.champagne);
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
            dark: '#112250',
            light: '#F5F4F0'
        }
    });

    // Large Centerpiece QR Box
    const qrContainerX = 167;
    const qrContainerY = 255;
    const qrSize = 260;

    // Glowing Frame
    doc.roundedRect(qrContainerX - 8, qrContainerY - 8, qrSize + 16, qrSize + 16, 16).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.champagne).lineWidth(2).roundedRect(qrContainerX - 8, qrContainerY - 8, qrSize + 16, qrSize + 16, 16).stroke();
    
    // QR Surface
    doc.roundedRect(qrContainerX, qrContainerY, qrSize, qrSize, 12).fill(PALETTE.ivory);
    doc.image(qrDataUrl, qrContainerX + 10, qrContainerY + 10, { width: qrSize - 20, height: qrSize - 20 });

    // Step-by-Step Instructions
    const stepsY = 548;
    doc.roundedRect(80, stepsY, 435.28, 130, 12).fill(PALETTE.sapphire);
    doc.strokeColor(PALETTE.warmTaupe).lineWidth(0.8).roundedRect(80, stepsY, 435.28, 130, 12).stroke();

    doc.font('Helvetica-Bold').fontSize(11).fillColor(PALETTE.champagne);
    doc.text('PANDUAN VERIFIKASI KEDATANGAN DI WAROENG LATTE:', 100, stepsY + 16, { width: 395.28 });

    doc.font('Helvetica').fontSize(9.5).fillColor(PALETTE.ivory);
    doc.text('1. Buka aplikasi kamera smartphone dan arahkan ke barcode di atas.', 100, stepsY + 38, { width: 395.28 });
    doc.text('2. Klik tautan yang muncul untuk membuka Buku Tamu Digital resmi.', 100, stepsY + 58, { width: 395.28 });
    doc.text('3. Pilih nama instansi/perusahaan Anda dan sampaikan sepatah kata ucapan.', 100, stepsY + 78, { width: 395.28 });
    doc.text('4. Nama instansi Anda akan langsung disambut di Layar Utama Pameran!', 100, stepsY + 98, { width: 395.28 });

    // Receptionist Assistance Note
    doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETTE.champagne);
    doc.text('Petugas Penerima Tamu Kami di Waroeng Latte Siap Membantu Anda', 40, 706, { align: 'center', width: 515.28 });

    doc.strokeColor(PALETTE.warmTaupe).lineWidth(0.5);
    doc.moveTo(100, 735).lineTo(495.28, 735).stroke();

    // Footer
    doc.font('Helvetica').fontSize(8.5).fillColor(PALETTE.warmTaupe);
    doc.text('WAROENG LATTE MADIUN • DIGITAL ARTIFICIAL INTELLIGENCE LAB 2026', 40, 746, { align: 'center', width: 515.28 });

    doc.end();
}

module.exports = {
    generateInvitationsPdf,
    generateVenueStandeePdf,
    PALETTE,
    EVENT_DETAILS
};
