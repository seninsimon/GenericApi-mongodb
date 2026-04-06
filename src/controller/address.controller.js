import Address from "../models/address.model.js";

// ➕ ADD ADDRESS
export const addAddress = async (req, res) => {
  try {
    const data = req.body;

    // if default → remove old default
    if (data.isDefault) {
      await Address.updateMany(
        { user: req.user._id },
        { isDefault: false }
      );
    }

    const address = await Address.create({
      ...data,
      user: req.user._id,
    });

    res.json(address);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// 📄 GET MY ADDRESSES
export const getMyAddresses = async (req, res) => {
  try {
    const addresses = await Address.find({ user: req.user._id });
    res.json(addresses);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ✏️ UPDATE ADDRESS
export const updateAddress = async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;

    if (data.isDefault) {
      await Address.updateMany(
        { user: req.user._id },
        { isDefault: false }
      );
    }

    const updated = await Address.findByIdAndUpdate(id, data, {
      new: true,
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ❌ DELETE ADDRESS
export const deleteAddress = async (req, res) => {
  try {
    const { id } = req.params;

    await Address.findByIdAndDelete(id);

    res.json({ message: "Address deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};