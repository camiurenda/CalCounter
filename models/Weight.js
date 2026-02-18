const mongoose = require('mongoose');

const weightSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true },
  peso: Number,
  fecha: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

weightSchema.index({ telegramId: 1, fecha: 1 });

module.exports = mongoose.model('Weight', weightSchema);
