const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  username: String,
  firstName: String,
  peso: Number,
  altura: Number,
  edad: Number,
  sexo: String,
  actividad: String,
  objetivo: String,
  metaCalorias: Number,
  metaProteinas: Number,
  metaCarbohidratos: Number,
  metaGrasas: Number,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
